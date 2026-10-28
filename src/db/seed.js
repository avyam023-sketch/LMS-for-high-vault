import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { migrate } from './migrate.js';
import { course, modules, questions } from './seed-content.js';

async function insertQuestion(db, { courseId, moduleId, pool: kind, position, prompt, options, correct, explanation }) {
  const right = Array.isArray(correct) ? correct : [correct];
  const { rows } = await db.query(
    `INSERT INTO questions (course_id, module_id, pool, position, prompt, kind, explanation)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [courseId, moduleId, kind, position, prompt, Array.isArray(correct) ? 'multi' : 'single', explanation ?? ''],
  );
  for (const [oi, body] of options.entries()) {
    await db.query('INSERT INTO question_options (question_id, body, is_correct, position) VALUES ($1, $2, $3, $4)', [
      rows[0].id, body, right.includes(oi), oi,
    ]);
  }
}

/**
 * Loads the Food Handler course: 10 modules (chapter + quiz each) and the final-exam bank.
 * Safe to run twice. `reset: true` deletes the course first — and with it every enrolment,
 * attempt and certificate for it — so only use that on a development database.
 */
export async function seed({ log = console.log, reset = false } = {}) {
  await migrate({ log });
  await tx(async (db) => {
    if (reset) {
      const { rowCount } = await db.query('DELETE FROM courses WHERE slug = $1', [course.slug]);
      if (rowCount) log(`Deleted existing "${course.slug}" and all of its learner data.`);
    }
    const exists = await db.query('SELECT id FROM courses WHERE slug = $1', [course.slug]);
    if (exists.rows.length) {
      log(`Course "${course.slug}" already exists; skipping. Use --reset on a development database to reload it.`);
      return;
    }
    const cols = Object.keys(course);
    const values = cols.map((c) => (['highlights', 'outcomes', 'faqs'].includes(c) ? JSON.stringify(course[c]) : course[c]));
    const { rows } = await db.query(
      `INSERT INTO courses (${cols.join(', ')}, is_published) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, true) RETURNING id`,
      values,
    );
    const courseId = rows[0].id;
    const moduleIds = [];
    for (const [mi, m] of modules.entries()) {
      const { rows: mr } = await db.query('INSERT INTO modules (course_id, title, summary, position) VALUES ($1, $2, $3, $4) RETURNING id', [courseId, m.title, m.summary ?? '', mi + 1]);
      moduleIds.push(mr[0].id);
      for (const [li, l] of m.lessons.entries()) {
        await db.query('INSERT INTO lessons (module_id, title, content_md, video_url, min_seconds, position) VALUES ($1, $2, $3, $4, $5, $6)', [
          mr[0].id, l.title, l.content_md, l.video_url ?? null, l.min_seconds, li + 1,
        ]);
      }
      for (const [qi, [prompt, options, correct, explanation]] of (m.quiz ?? []).entries()) {
        await insertQuestion(db, { courseId, moduleId: mr[0].id, pool: 'quiz', position: qi + 1, prompt, options, correct, explanation });
      }
    }
    for (const [prompt, options, correct, moduleIndex, explanation] of questions) {
      await insertQuestion(db, { courseId, moduleId: moduleIds[moduleIndex], pool: 'exam', position: 0, prompt, options, correct, explanation });
    }
    const quizCount = modules.reduce((n, m) => n + (m.quiz?.length ?? 0), 0);
    log(`Seeded "${course.title}": ${modules.length} modules, ${modules.flatMap((m) => m.lessons).length} chapters, ${quizCount} quiz questions, ${questions.length} exam questions.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed({ reset: process.argv.includes('--reset') })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
