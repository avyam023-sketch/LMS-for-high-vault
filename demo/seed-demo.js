// Fictional sample data for the click-through preview (demo/build.js). Never run against production.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { many, one, query } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/passwords.js';
import { encryptBuffer, shuffle } from '../src/lib/crypto.js';
import { courseOutline, finalizeAttempt, reviewAttempt } from '../src/lib/exam.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
export const DEMO_PASSWORD = 'sample learner passphrase';
const daysAgo = (d, h = 10) => new Date(Date.now() - d * 86_400_000 - h * 3_600_000);

async function user({ email, first, last, role = 'student', daysOld }) {
  const u = await one(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at, created_at, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING id`,
    [email, await hashPassword(DEMO_PASSWORD), first, last, role, daysAgo(daysOld), daysAgo(Math.max(0, daysOld - 2), 3)],
  );
  return { id: u.id, email, first, last };
}

/** Marks the first `upTo` outline items (chapters and quizzes) complete for a learner. */
async function progress(u, course, upTo) {
  await query('INSERT INTO enrollments (user_id, course_id, enrolled_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING', [u.id, course.id]);
  const outline = await courseOutline(course.id, u.id);
  for (const item of outline.items.slice(0, upTo)) {
    if (item.type === 'lesson') {
      await query(
        `INSERT INTO lesson_progress (user_id, lesson_id, seconds_spent, completed_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, lesson_id) DO UPDATE SET completed_at = now(), seconds_spent = EXCLUDED.seconds_spent`,
        [u.id, item.id, item.min_seconds + 120],
      );
    } else {
      await query(
        `INSERT INTO quiz_answers (user_id, question_id, tries, correct_at)
         SELECT $1, id, 1 + (random() * 1)::int, now() FROM questions WHERE module_id = $2 AND pool = 'quiz'
         ON CONFLICT DO NOTHING`,
        [u.id, item.module_id],
      );
    }
  }
}

/** A submitted exam with roughly `scorePct` correct, timed in the past. */
async function attempt(u, course, { scorePct, daysOld, status = 'in_progress', events = [], evidence = false }) {
  const bank = await many(
    `SELECT q.id, array_agg(o.id) AS option_ids FROM questions q JOIN question_options o ON o.question_id = q.id
      WHERE q.course_id = $1 AND q.pool = 'exam' GROUP BY q.id`,
    [course.id],
  );
  const picked = shuffle(bank).slice(0, course.exam_question_count);
  const started = daysAgo(daysOld, 2);
  const a = await one(
    `INSERT INTO exam_attempts (user_id, course_id, question_ids, option_order, status, started_at, checkin_started_at, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, '198.51.100.24', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36')
     RETURNING id`,
    [u.id, course.id, picked.map((q) => q.id), Object.fromEntries(picked.map((q) => [q.id, shuffle(q.option_ids)])),
      status === 'in_progress_keep' ? 'in_progress' : status, started,
      new Date(started.getTime() + course.exam_time_limit_minutes * 60_000)],
  );
  if (evidence) {
    const put = async (kind, file, mime, at, note = null) => {
      const body = await readFile(path.join(assets, file));
      await query('INSERT INTO proctor_media (attempt_id, kind, mime, byte_size, data, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        a.id, kind, mime, body.length, encryptBuffer(body, { purpose: 'proctor-media', context: `${a.id}:${kind}` }), note, at,
      ]);
    };
    await put('face', 'sample-face.jpg', 'image/jpeg', started);
    await put('id', 'sample-id.jpg', 'image/jpeg', started);
    await put('room_scan', 'sample-room.webm', 'video/webm', started);
    for (const [i, note] of ['start', '', 'window_blur'].entries()) {
      await put('snapshot', `sample-snapshot-${i + 1}.jpg`, 'image/jpeg', new Date(started.getTime() + (i + 1) * 9 * 60_000), note || null);
    }
  }
  // Answer: correct for the first scorePct% of questions, a wrong option for the rest.
  const target = Math.round((picked.length * scorePct) / 100);
  for (const [i, q] of picked.entries()) {
    const opts = await many('SELECT id, is_correct FROM question_options WHERE question_id = $1', [q.id]);
    const choice = i < target ? opts.filter((o) => o.is_correct).map((o) => o.id) : [opts.find((o) => !o.is_correct).id];
    await query('INSERT INTO attempt_answers (attempt_id, question_id, option_ids, answered_at) VALUES ($1, $2, $3, $4)', [
      a.id, q.id, choice, new Date(started.getTime() + (i + 1) * 70_000),
    ]);
  }
  for (const [kind, minute, counted, detail] of events) {
    await query('INSERT INTO integrity_events (attempt_id, kind, counted, detail, ip, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      a.id, kind, counted, detail ?? null, '198.51.100.24', new Date(started.getTime() + minute * 60_000),
    ]);
  }
  await query('UPDATE exam_attempts SET focus_violations = $2 WHERE id = $1', [a.id, events.filter((e) => e[2]).length]);
  if (status !== 'in_progress_keep') {
    const done = await finalizeAttempt(a.id, events.some((e) => e[0] === 'auto') ? 'integrity' : null);
    const submitted = new Date(started.getTime() + 38 * 60_000);
    await query('UPDATE exam_attempts SET submitted_at = $2 WHERE id = $1', [a.id, submitted]);
    await query('UPDATE certificates SET issued_at = $2, expires_at = $2::timestamptz + interval \'1 month\' * $3 WHERE attempt_id = $1', [a.id, submitted, course.certificate_validity_months]);
    return done.id;
  }
  return a.id;
}

export async function seedDemo() {
  const course = await one('SELECT * FROM courses LIMIT 1');
  await query(`UPDATE courses SET price_cents = 4900 WHERE id = $1`, [course.id]);
  course.price_cents = 4900;
  const total = (await courseOutline(course.id, null)).items.length;
  const people = {};

  // The learner whose screens the preview shows: every module done, ready for the exam.
  people.you = await user({ email: 'alex.morgan@example.com', first: 'Alex', last: 'Morgan', daysOld: 6 });
  await progress(people.you, course, total);
  // Mid-course learners.
  for (const [key, first, last, steps, d] of [
    ['liam', 'Liam', "O'Connor", 7, 9], ['sofia', 'Sofia', 'Rossi', 1, 1], ['chloe', 'Chloé', 'Gagnon', 13, 12],
    ['noah', 'Noah', 'Campbell', 4, 3], ['maya', 'Maya', 'Singh', 17, 8],
  ]) {
    people[key] = await user({ email: `${first.toLowerCase().replace('é', 'e')}.${last.toLowerCase().replace("'", '')}@example.com`, first, last, daysOld: d });
    await progress(people[key], course, steps);
  }
  // Certified learners (approved by a reviewer).
  const admin = await user({ email: 'admin@example.com', first: 'Morgan', last: 'Reid', role: 'admin', daysOld: 25 });
  for (const [key, first, last, score, d] of [['jordan', 'Jordan', 'Tremblay', 93, 14], ['priya', 'Priya', 'Sharma', 87, 11], ['daniel', 'Daniel', 'Kim', 80, 5]]) {
    people[key] = await user({ email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, first, last, daysOld: d + 4 });
    await progress(people[key], course, total);
    const id = await attempt(people[key], course, { scorePct: score, daysOld: d, evidence: true });
    await reviewAttempt(id, admin.id, 'approve', 'ID matches account; room clear.');
    await query(`UPDATE exam_attempts SET reviewed_at = submitted_at + interval '3 hours' WHERE id = $1`, [id]);
    await query(`UPDATE certificates SET issued_at = $2, expires_at = $2::timestamptz + interval '1 month' * $3 WHERE attempt_id = $1`, [id, daysAgo(d - 0.2, 0), course.certificate_validity_months]);
    people[key].attemptId = id;
  }
  // Waiting for identity review (the reviewer's queue).
  people.taylor = await user({ email: 'taylor.nguyen@example.com', first: 'Taylor', last: 'Nguyen', daysOld: 4 });
  await progress(people.taylor, course, total);
  people.taylor.attemptId = await attempt(people.taylor, course, {
    scorePct: 90, daysOld: 0, evidence: true,
    events: [['window_blur', 14, true, null], ['noise', 22, false, 'Sustained sound or talking'], ['tab_hidden', 31, false, null]],
  });
  people.amara = await user({ email: 'amara.okafor@example.com', first: 'Amara', last: 'Okafor', daysOld: 3 });
  await progress(people.amara, course, total);
  people.amara.attemptId = await attempt(people.amara, course, { scorePct: 83, daysOld: 0, evidence: true });
  // Did not pass yet (cooldown), and one exam ended for leaving the page too often.
  people.marcus = await user({ email: 'marcus.leblanc@example.com', first: 'Marcus', last: 'Leblanc', daysOld: 7 });
  await progress(people.marcus, course, total);
  people.marcus.attemptId = await attempt(people.marcus, course, { scorePct: 60, daysOld: 0, evidence: true });
  people.ethan = await user({ email: 'ethan.wong@example.com', first: 'Ethan', last: 'Wong', daysOld: 10 });
  await progress(people.ethan, course, total);
  people.ethan.attemptId = await attempt(people.ethan, course, {
    scorePct: 40, daysOld: 2, evidence: true,
    events: [['tab_hidden', 5, true], ['window_blur', 9, true], ['multiple_faces', 12, false, '2 faces in view'], ['fullscreen_exit', 15, true], ['tab_hidden', 18, true], ['auto', 18, false]],
  });
  await query(`DELETE FROM integrity_events WHERE kind = 'auto'`);

  // An exam in progress, so the live view isn't empty. (demo/build.js starts "your" check-in itself.)
  people.sam = await user({ email: 'sam.patel@example.com', first: 'Sam', last: 'Patel', daysOld: 5 });
  await progress(people.sam, course, total);
  people.sam.attemptId = await attempt(people.sam, course, { scorePct: 0, daysOld: 0, status: 'in_progress_keep', evidence: true });
  await query(`UPDATE exam_attempts SET status = 'in_progress', started_at = now(), expires_at = now() + interval '60 minutes' WHERE id = $1`, [people.sam.attemptId]);
  await query('DELETE FROM attempt_answers WHERE attempt_id = $1', [people.sam.attemptId]);

  // A reviewer account, and some audit history so the log isn't empty.
  await user({ email: 'reviewer@example.com', first: 'Casey', last: 'Fraser', role: 'reviewer', daysOld: 20 });
  const learners = await many(`SELECT id, created_at FROM users WHERE role = 'student'`);
  for (const l of learners) {
    await query(`INSERT INTO audit_log (actor_id, action, entity, entity_id, ip, created_at) VALUES ($1, 'user.register', 'user', $2, '198.51.100.24', $3)`, [l.id, String(l.id), l.created_at]);
    await query(`INSERT INTO audit_log (actor_id, action, entity, entity_id, ip, created_at) VALUES ($1, 'auth.login', 'user', $2, '198.51.100.24', $3)`, [l.id, String(l.id), new Date(new Date(l.created_at).getTime() + 3_600_000)]);
  }
  const certCode = (await one('SELECT code FROM certificates WHERE user_id = $1', [people.jordan.id])).code;
  return { course, people, admin, certCode };
}
