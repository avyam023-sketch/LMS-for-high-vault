import express, { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  beginAttempt, CHECKIN_MINUTES, examPaper, finalizeAttempt, isExpired, loadAttempt, LOGGED_EVENTS, moduleBreakdown,
  recordIntegrityEvent, saveAnswer,
} from '../lib/exam.js';
import { encryptBuffer } from '../lib/crypto.js';
import { many, one, query } from '../db/pool.js';
import { apiLimiter } from '../lib/limits.js';
import { parse } from '../lib/validate.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
const notFoundPage = (res) => res.status(404).render('error', { title: 'Page not found', status: 404, message: 'Exam not found.' });

/** Loads the learner's own attempt; closes it if time ran out, drops it if check-in lapsed. */
async function attemptFor(req) {
  let attempt = await loadAttempt(req.params.attemptId, req.user.id);
  if (attempt?.status === 'checkin' && new Date(attempt.checkin_started_at).getTime() + CHECKIN_MINUTES * 60_000 < Date.now()) {
    await query(`DELETE FROM exam_attempts WHERE id = $1 AND status = 'checkin'`, [attempt.id]);
    return { lapsed: true, course_slug: attempt.course_slug };
  }
  if (attempt?.status === 'in_progress' && isExpired(attempt)) {
    await finalizeAttempt(attempt.id, 'time');
    attempt = await loadAttempt(req.params.attemptId, req.user.id);
  }
  return attempt;
}

router.get('/exam/:attemptId', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt) return notFoundPage(res);
  if (attempt.lapsed) {
    flash(req, 'warn', `Your check-in wasn’t finished within ${CHECKIN_MINUTES} minutes, so it was cancelled. It didn’t use an attempt — start again when you’re ready.`);
    return res.redirect(`/learn/${attempt.course_slug}/exam`);
  }
  if (attempt.status === 'checkin') {
    const media = await many('SELECT kind, count(*)::int AS n FROM proctor_media WHERE attempt_id = $1 GROUP BY kind', [attempt.id]);
    return res.render('learn/exam-checkin', {
      title: `Exam check-in — ${attempt.course_title}`,
      attempt,
      done: Object.fromEntries(media.map((m) => [m.kind, true])),
      bodyClass: 'checkin-mode',
      checkinMinutes: CHECKIN_MINUTES,
    });
  }
  if (attempt.status !== 'in_progress') return res.redirect(`/exam/${attempt.id}/result`);
  res.render('learn/exam', {
    title: `Exam — ${attempt.course_title}`,
    attempt,
    bodyClass: 'exam-mode',
    watermark: `${req.user.first_name} ${req.user.last_name} · ${req.user.email}`,
  });
});

/** The question paper. Correct answers never leave the server, and nothing is served before check-in ends. */
router.get('/exam/:attemptId/paper', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return res.status(404).json({ error: 'Not found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}` });
  res.json({
    expiresAt: attempt.expires_at,
    serverNow: new Date().toISOString(),
    maxViolations: attempt.max_focus_violations,
    violations: attempt.focus_violations,
    requireFullscreen: attempt.require_fullscreen,
    proctored: attempt.proctoring_required,
    questions: await examPaper(attempt),
  });
});

const answerSchema = z.object({ questionId: z.uuid(), optionIds: z.array(z.uuid()).max(10) });

router.post('/exam/:attemptId/answer', requireAuth, apiLimiter, async (req, res) => {
  const { data, errors } = parse(answerSchema, req.body);
  if (errors) return res.status(400).json({ error: 'Invalid answer.' });
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return res.status(404).json({ error: 'Not found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}/result` });
  const error = await saveAnswer(attempt, data.questionId, data.optionIds);
  if (error) return res.status(400).json({ error });
  res.json({ saved: true });
});

const eventSchema = z.object({ kind: z.string().max(40), detail: z.string().max(300).optional() });

router.post('/exam/:attemptId/event', requireAuth, apiLimiter, async (req, res) => {
  const { data, errors } = parse(eventSchema, req.body);
  if (errors || !LOGGED_EVENTS.has(data.kind)) return res.status(400).json({ error: 'Invalid event.' });
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return res.status(404).json({ error: 'Not found' });
  if (!['checkin', 'in_progress'].includes(attempt.status)) {
    return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}/result` });
  }
  const result = await recordIntegrityEvent(attempt, data.kind, data.detail, req.ip);
  if (result.terminated) {
    await audit(req, 'exam.terminated_integrity', { entity: 'attempt', entityId: attempt.id, meta: { violations: result.violations } });
    return res.json({ ...result, redirect: `/exam/${attempt.id}/result` });
  }
  res.json({ ...result, maxViolations: attempt.max_focus_violations });
});

// ---------- Proctoring media ----------

const MEDIA_RULES = {
  face: { phase: 'checkin', types: ['image/jpeg'], max: 3 * 1024 * 1024, replace: true },
  id: { phase: 'checkin', types: ['image/jpeg'], max: 3 * 1024 * 1024, replace: true },
  room_scan: { phase: 'checkin', types: ['video/webm', 'video/mp4'], max: 60 * 1024 * 1024, replace: true },
  snapshot: { phase: 'in_progress', types: ['image/jpeg'], max: 1024 * 1024, replace: false },
};

/** Checks the file's leading bytes match its declared type — never trust Content-Type alone. */
function looksLike(mime, buf) {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'video/webm') return buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3;
  if (mime === 'video/mp4') return buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp';
  return false;
}

router.post(
  '/exam/:attemptId/media',
  requireAuth,
  apiLimiter,
  express.raw({ type: ['image/jpeg', 'video/webm', 'video/mp4'], limit: '60mb' }),
  async (req, res) => {
    const kind = String(req.query.kind ?? '');
    const rule = MEDIA_RULES[kind];
    if (!rule) return res.status(400).json({ error: 'Unknown media type.' });
    const attempt = await attemptFor(req);
    if (!attempt || attempt.lapsed) return res.status(404).json({ error: 'Not found' });
    if (attempt.status !== rule.phase) return res.status(409).json({ error: 'This upload is not allowed at this stage.' });
    const mime = req.get('content-type')?.split(';')[0].trim();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!rule.types.includes(mime) || body.length === 0 || body.length > rule.max || !looksLike(mime, body)) {
      return res.status(400).json({ error: 'That file could not be accepted.' });
    }
    if (kind === 'snapshot') {
      const { n } = await one(`SELECT count(*)::int AS n FROM proctor_media WHERE attempt_id = $1 AND kind = 'snapshot'`, [attempt.id]);
      if (n >= attempt.exam_time_limit_minutes * 4 + 40) return res.status(429).json({ error: 'Snapshot limit reached.' });
    }
    if (rule.replace) await query('DELETE FROM proctor_media WHERE attempt_id = $1 AND kind = $2', [attempt.id, kind]);
    const note = String(req.query.note ?? '').slice(0, 60) || null;
    await query('INSERT INTO proctor_media (attempt_id, kind, mime, byte_size, data, note) VALUES ($1, $2, $3, $4, $5, $6)', [
      attempt.id, kind, mime, body.length, encryptBuffer(body), note,
    ]);
    res.json({ saved: true });
  },
);

/** Check-in complete: start the clock. */
router.post('/exam/:attemptId/begin', requireAuth, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return res.status(404).json({ error: 'Not found' });
  if (attempt.status === 'in_progress') return res.json({ redirect: `/exam/${attempt.id}` });
  if (attempt.status !== 'checkin') return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}/result` });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the exam conditions first.' });
  const result = await beginAttempt(attempt);
  if (result.error === 'missing_media') {
    return res.status(400).json({ error: `Finish these check-in steps first: ${result.missing.join(', ').replace('room_scan', 'room scan')}.` });
  }
  if (result.error) return res.status(409).json({ error: 'The exam could not be started.' });
  await audit(req, 'exam.started', { entity: 'attempt', entityId: attempt.id });
  res.json({ redirect: `/exam/${attempt.id}` });
});

/** Learner backs out of check-in. Nothing was shown, so the attempt is simply discarded. */
router.post('/exam/:attemptId/cancel', requireAuth, async (req, res) => {
  const attempt = await attemptFor(req);
  if (attempt && !attempt.lapsed && attempt.status === 'checkin') {
    await query(`DELETE FROM exam_attempts WHERE id = $1 AND status = 'checkin'`, [attempt.id]);
  }
  res.redirect(attempt?.course_slug ? `/learn/${attempt.course_slug}/exam` : '/dashboard');
});

router.post('/exam/:attemptId/submit', requireAuth, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return notFoundPage(res);
  if (attempt.status === 'in_progress') {
    const done = await finalizeAttempt(attempt.id);
    await audit(req, 'exam.submitted', { entity: 'attempt', entityId: attempt.id, meta: { score: done.score_percent, passed: done.passed } });
  }
  if (req.is('json')) return res.json({ redirect: `/exam/${attempt.id}/result` });
  res.redirect(`/exam/${attempt.id}/result`);
});

router.get('/exam/:attemptId/result', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt || attempt.lapsed) return notFoundPage(res);
  if (['checkin', 'in_progress'].includes(attempt.status)) return res.redirect(`/exam/${attempt.id}`);
  const certificate = attempt.passed ? await one('SELECT * FROM certificates WHERE attempt_id = $1', [attempt.id]) : null;
  res.render('learn/exam-result', {
    title: 'Exam result',
    attempt,
    certificate,
    breakdown: attempt.status === 'voided' ? [] : await moduleBreakdown(attempt),
  });
});

export default router;
