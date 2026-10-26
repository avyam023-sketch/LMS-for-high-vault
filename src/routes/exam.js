import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  examPaper, finalizeAttempt, isExpired, loadAttempt, LOGGED_EVENTS, moduleBreakdown, recordIntegrityEvent, saveAnswer,
} from '../lib/exam.js';
import { one } from '../db/pool.js';
import { apiLimiter } from '../lib/limits.js';
import { parse } from '../lib/validate.js';

const router = Router();
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Loads the learner's own attempt; closes it first if time ran out. */
async function attemptFor(req) {
  let attempt = await loadAttempt(req.params.attemptId, req.user.id);
  if (attempt?.status === 'in_progress' && isExpired(attempt)) {
    await finalizeAttempt(attempt.id, 'time');
    attempt = await loadAttempt(req.params.attemptId, req.user.id);
  }
  return attempt;
}

router.get('/exam/:attemptId', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt) return res.status(404).render('error', { title: 'Page not found', status: 404, message: 'Exam not found.' });
  if (attempt.status !== 'in_progress') return res.redirect(`/exam/${attempt.id}/result`);
  res.render('learn/exam', {
    title: `Exam — ${attempt.course_title}`,
    attempt,
    bodyClass: 'exam-mode',
    watermark: `${req.user.first_name} ${req.user.last_name} · ${req.user.email}`,
  });
});

/** The question paper. Correct answers never leave the server. */
router.get('/exam/:attemptId/paper', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt) return res.status(404).json({ error: 'Not found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}/result` });
  res.json({
    expiresAt: attempt.expires_at,
    serverNow: new Date().toISOString(),
    maxViolations: attempt.max_focus_violations,
    violations: attempt.focus_violations,
    requireFullscreen: attempt.require_fullscreen,
    questions: await examPaper(attempt),
  });
});

const answerSchema = z.object({ questionId: z.uuid(), optionIds: z.array(z.uuid()).max(10) });

router.post('/exam/:attemptId/answer', requireAuth, apiLimiter, async (req, res) => {
  const { data, errors } = parse(answerSchema, req.body);
  if (errors) return res.status(400).json({ error: 'Invalid answer.' });
  const attempt = await attemptFor(req);
  if (!attempt) return res.status(404).json({ error: 'Not found' });
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
  if (!attempt) return res.status(404).json({ error: 'Not found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'closed', redirect: `/exam/${attempt.id}/result` });
  const result = await recordIntegrityEvent(attempt, data.kind, data.detail, req.ip);
  if (result.terminated) {
    await audit(req, 'exam.terminated_integrity', { entity: 'attempt', entityId: attempt.id, meta: { violations: result.violations } });
    return res.json({ ...result, redirect: `/exam/${attempt.id}/result` });
  }
  res.json({ ...result, maxViolations: attempt.max_focus_violations });
});

router.post('/exam/:attemptId/submit', requireAuth, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt) return res.status(404).render('error', { title: 'Page not found', status: 404, message: 'Exam not found.' });
  if (attempt.status === 'in_progress') {
    const done = await finalizeAttempt(attempt.id);
    await audit(req, 'exam.submitted', { entity: 'attempt', entityId: attempt.id, meta: { score: done.score_percent, passed: done.passed } });
  }
  if (req.is('json')) return res.json({ redirect: `/exam/${attempt.id}/result` });
  res.redirect(`/exam/${attempt.id}/result`);
});

router.get('/exam/:attemptId/result', requireAuth, noStore, async (req, res) => {
  const attempt = await attemptFor(req);
  if (!attempt) return res.status(404).render('error', { title: 'Page not found', status: 404, message: 'Exam not found.' });
  if (attempt.status === 'in_progress') return res.redirect(`/exam/${attempt.id}`);
  const certificate = attempt.passed
    ? await one('SELECT * FROM certificates WHERE attempt_id = $1', [attempt.id])
    : null;
  res.render('learn/exam-result', {
    title: 'Exam result',
    attempt,
    certificate,
    breakdown: attempt.status === 'voided' ? [] : await moduleBreakdown(attempt),
  });
});

export default router;
