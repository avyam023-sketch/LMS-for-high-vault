import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { migrate } from './migrate.js';
import { course, modules, questions } from './seed-content.js';

/** Loads the Food Handler course, its lessons and question bank. Safe to run twice. */
export async function seed({ log = console.log } = {}) {
  await migrate({ log });
  await tx(async (db) => {
    const exists = await db.query('SELECT id FROM courses WHERE slug = $1', [course.slug]);
    if (exists.rows.length) {
      log(`Course "${course.slug}" already exists; skipping.`);
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
      const { rows: mr } = await db.query('INSERT INTO modules (course_id, title, position) VALUES ($1, $2, $3) RETURNING id', [courseId, m.title, mi + 1]);
      moduleIds.push(mr[0].id);
      for (const [li, l] of m.lessons.entries()) {
        await db.query('INSERT INTO lessons (module_id, title, content_md, min_seconds, position) VALUES ($1, $2, $3, $4, $5)', [
          mr[0].id, l.title, l.content_md, l.min_seconds, li + 1,
        ]);
      }
    }
    for (const [prompt, options, correct, moduleIndex, explanation] of questions) {
      const right = Array.isArray(correct) ? correct : [correct];
      const { rows: qr } = await db.query(
        'INSERT INTO questions (course_id, module_id, prompt, kind, explanation) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [courseId, moduleIds[moduleIndex], prompt, Array.isArray(correct) ? 'multi' : 'single', explanation],
      );
      for (const [oi, body] of options.entries()) {
        await db.query('INSERT INTO question_options (question_id, body, is_correct, position) VALUES ($1, $2, $3, $4)', [qr[0].id, body, right.includes(oi), oi]);
      }
    }
    log(`Seeded "${course.title}": ${modules.length} modules, ${modules.flatMap((m) => m.lessons).length} lessons, ${questions.length} questions.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
