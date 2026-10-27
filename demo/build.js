// Builds the click-through preview: runs the real app against sample data, saves every screen a visitor
// can reach as static files, and rewrites links for a sub-path host such as GitHub Pages.
//
//   DATABASE_URL=… NODE_ENV=test REQUIRE_ADMIN_MFA=false REQUIRE_EMAIL_VERIFICATION=false \
//   APP_URL=https://example.github.io/repo BASE=/repo node demo/build.js [outDir]
//
// The database is wiped first. Never point this at a real one.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(root, 'demo', 'dist'));
const BASE = (process.env.BASE ?? '').replace(/\/$/, '');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run the preview build in production.');

const request = (await import('supertest')).default;
const { pool, one, many, query } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const { createApp } = await import('../src/app.js');
const { encryptBuffer } = await import('../src/lib/crypto.js');
const { courseOutline, itemUrl } = await import('../src/lib/exam.js');
const { seedDemo, DEMO_PASSWORD } = await import('./seed-demo.js');

// ---------- Sample data ----------
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate({ log: () => {} });
await seed({ log: () => {} });
const demo = await seedDemo();
const { course, people } = demo;
const app = createApp();

// ---------- URL → file mapping ----------
const FILE_EXT = /\.(pdf|csv|json|txt|xml|svg|png|jpe?g|webp|webm|mp4|woff2?|css|js|ico|webmanifest)$/i;
const STATIC = /^\/(css|js|img|fonts|vendor|demo)\/|^\/(site\.webmanifest|favicon\.ico)$/;
const SKIP = /^\/(logout|login\/mfa|verify-email|reset-password|payments|enroll|healthz|account\/mfa)/;
const mediaExt = { 'image/jpeg': '.jpg', 'video/webm': '.webm', 'video/mp4': '.mp4', 'application/json': '.json' };
const extFor = new Map(); // app path → extension added on export (media, JSON)

function querySlug(search) {
  const params = [...new URLSearchParams(search)].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b));
  return params.map(([k, v]) => `${k}-${v}`).join('~').replace(/[^\w.~-]/g, '_');
}

/** The published path for an app URL: pages become folders, query strings become sub-folders. */
function publishedPath(url) {
  const u = new URL(url, 'http://app');
  const p = decodeURIComponent(u.pathname);
  if (FILE_EXT.test(p)) return p;
  if (extFor.has(p)) return p + extFor.get(p);
  const q = querySlug(u.search);
  return `${p.replace(/\/$/, '')}/${q ? `_q/${q}/` : ''}`;
}
const published = (url) => {
  const u = new URL(url, 'http://app');
  return BASE + publishedPath(url) + (u.hash || '');
};

// ---------- Fetching ----------
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const get = (agent, url) => agent.get(url).set('Accept-Encoding', 'identity').buffer(true).parse(binary);
const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];

async function signIn(email) {
  const agent = request.agent(app);
  const page = await get(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.body.toString()), email, password: DEMO_PASSWORD });
  if (res.status !== 302 || /login/.test(res.headers.location)) throw new Error(`Sign-in failed for ${email}`);
  return agent;
}
const agents = { anon: request.agent(app), you: await signIn(people.you.email), admin: await signIn(demo.admin.email) };
const LEARNER = /^\/(dashboard|learn|exam|account|certificates)(\/|$)/;
const agentFor = (p) => (p.startsWith('/admin') ? 'admin' : LEARNER.test(p) ? 'you' : 'anon');

// ---------- Rewriting ----------
const exported = new Set(); // published paths that exist
const pageData = new Map(); // app path → extra data for demo.js on that page
const overrides = new Map(); // app path → [[from, to]] link swaps applied before rewriting

function rewriteHtml(html, appPath) {
  for (const [from, to] of overrides.get(appPath) ?? []) html = html.split(`href="${from}"`).join(`href="${to}"`);
  html = html.replace(/\b(href|src|action|poster)="(\/(?!\/)[^"]*)"/g, (m, attr, url) => {
    const raw = url.replace(/&amp;/g, '&');
    const u = new URL(raw, 'http://app');
    if (STATIC.test(u.pathname)) return `${attr}="${BASE}${url}"`;
    if (attr === 'action') return `${attr}="${BASE}${u.pathname}"`;
    const target = published(raw);
    const missing = !exported.has(publishedPath(raw)) && !(u.pathname === '/' && !u.search);
    return `${attr}="${target.replace(/&/g, '&amp;')}"${missing && attr === 'href' ? ' data-demo-off' : ''}`;
  });
  html = html.replace(/\bsrcset="([^"]*)"/g, (m, set) => `srcset="${set.replace(/(^|,\s*)\//g, `$1${BASE}/`)}"`);
  const data = JSON.stringify({ base: BASE, page: pageData.get(appPath) ?? null, ...shared }).replace(/</g, '\\u003c');
  const inject = [
    '<meta name="robots" content="noindex, nofollow">',
    `<script type="application/json" id="demo-data">${data}</script>`,
    `<link rel="stylesheet" href="${BASE}/demo/demo.css">`,
    `<script src="${BASE}/demo/demo.js"></script>`,
  ].join('\n  ');
  return html.replace(/<meta name="robots" content="noindex">\n?/, '').replace('</head>', `  ${inject}\n</head>`);
}

const files = new Map(); // published path → { body, html, appPath }
function save(appPath, res, pathOverride) {
  const type = (res.headers['content-type'] ?? '').split(';')[0];
  let out = pathOverride ?? publishedPath(appPath);
  if (type === 'text/html') {
    if (!out.endsWith('/') && !out.endsWith('.html')) out += '/';
    files.set(out, { html: res.body.toString('utf8'), appPath: new URL(appPath, 'http://app').pathname + new URL(appPath, 'http://app').search });
  } else {
    files.set(out, { body: res.body });
  }
  exported.add(out);
}
function redirectPage(to) {
  const target = published(to);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}"><title>Redirecting…</title><a href="${target}">Continue</a>`;
}

// ---------- Crawl ----------
const queue = [];
const seen = new Set();
const enqueue = (url) => {
  const u = new URL(url, 'http://app');
  if (u.origin !== 'http://app' || STATIC.test(u.pathname) || SKIP.test(u.pathname)) return;
  const key = u.pathname + u.search;
  if (!seen.has(key)) {
    seen.add(key);
    queue.push(key);
  }
};

async function fetchPage(url) {
  const p = new URL(url, 'http://app').pathname;
  let res = await get(agents[agentFor(p)], url);
  // Someone else's certificate or a staff-only file: the admin can open it.
  if (res.status >= 400 && agentFor(p) !== 'admin') res = await get(agents.admin, url);
  return res;
}

async function crawl() {
  while (queue.length) {
    const url = queue.shift();
    const res = await fetchPage(url);
    if (res.status >= 300 && res.status < 400) {
      const to = new URL(res.headers.location, 'http://app');
      enqueue(to.pathname + to.search);
      files.set(publishedPath(url), { redirect: to.pathname + to.search });
      exported.add(publishedPath(url));
      continue;
    }
    if (res.status !== 200 && !(res.status === 404 && url.startsWith('/verify/'))) {
      console.warn(`  skipped ${url} (${res.status})`);
      continue;
    }
    const type = (res.headers['content-type'] ?? '').split(';')[0];
    if (type !== 'text/html' && !FILE_EXT.test(new URL(url, 'http://app').pathname)) extFor.set(new URL(url, 'http://app').pathname, mediaExt[type] ?? '');
    save(url, res);
    if (type === 'text/html') {
      for (const [, attr, link] of res.body.toString('utf8').matchAll(/\b(href|src)="(\/(?!\/)[^"#]*)/g)) {
        if (attr === 'src' && !link.startsWith('/admin/media/')) continue;
        enqueue(link.replace(/&amp;/g, '&'));
      }
    }
  }
}

console.log('Crawling…');
for (const seedUrl of ['/', `/course/${course.slug}`, '/register', '/login', '/forgot-password', '/verify', `/verify/${demo.certCode}`,
  '/verify/HV-0000-0000-0000', '/privacy', '/terms', '/dashboard', '/account', `/learn/${course.slug}`, `/learn/${course.slug}/exam`,
  '/admin', '/admin/attempts', '/admin/users', '/admin/certificates', '/admin/audit', '/admin/courses']) enqueue(seedUrl);
// The quiz pages are exported separately below (each question, and the feedback after it).
const outline = await courseOutline(course.id, people.you.id);
for (const item of outline.items) if (item.type === 'quiz') seen.add(itemUrl(course.slug, item));
await crawl();

// ---------- Module quizzes: every question, plus the "Correct" screen after each ----------
console.log('Exporting quizzes…');
for (const item of outline.items.filter((i) => i.type === 'quiz')) {
  const url = itemUrl(course.slug, item);
  const qs = await many(
    `SELECT id, kind FROM questions WHERE module_id = $1 AND pool = 'quiz' AND is_active ORDER BY position, created_at`,
    [item.module_id],
  );
  const saved = await many('SELECT * FROM quiz_answers WHERE user_id = $1 AND question_id = ANY($2)', [people.you.id, qs.map((q) => q.id)]);
  await query('DELETE FROM quiz_answers WHERE user_id = $1 AND question_id = ANY($2)', [people.you.id, qs.map((q) => q.id)]);
  const stateUrl = (i) => (i === 0 ? `${url}` : `${url}/q${i + 1}`);
  for (const [i, q] of qs.entries()) {
    const correct = (await many('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [q.id])).map((r) => r.id);
    const page = await get(agents.you, url);
    const at = publishedPath(stateUrl(i));
    files.set(at, { html: page.body.toString('utf8'), appPath: `${stateUrl(i)}` });
    exported.add(at);
    pageData.set(stateUrl(i), { quiz: { correct, multi: q.kind === 'multi', next: published(`${url}/q${i + 1}/correct`) } });
    await agents.you.post(url).type('form').send({ _csrf: csrfFrom(page.body.toString()), question_id: q.id, option: correct });
    const done = await get(agents.you, url);
    const cAt = publishedPath(`${url}/q${i + 1}/correct`);
    files.set(cAt, { html: done.body.toString('utf8'), appPath: `${url}/q${i + 1}/correct` });
    exported.add(cAt);
    overrides.set(`${url}/q${i + 1}/correct`, [[url, i + 1 < qs.length ? stateUrl(i + 1) : `${url}/complete`]]);
  }
  const complete = await get(agents.you, url);
  files.set(publishedPath(`${url}/complete`), { html: complete.body.toString('utf8'), appPath: `${url}/complete` });
  exported.add(publishedPath(`${url}/complete`));
  // Put the learner's real progress back.
  for (const r of saved) {
    await query('INSERT INTO quiz_answers (user_id, question_id, tries, correct_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, question_id) DO UPDATE SET tries = $3, correct_at = $4', [r.user_id, r.question_id, r.tries, r.correct_at]);
  }
}

// ---------- Check-in, the live exam and its result ----------
console.log('Exporting the exam…');
const lobby = await get(agents.you, `/learn/${course.slug}/exam`);
const started = await agents.you.post(`/learn/${course.slug}/exam/start`).type('form')
  .send({ _csrf: csrfFrom(lobby.body.toString()), agree_alone: 'on', agree_devices: 'on', agree_rules: 'on', agree_recording: 'on' });
const attemptId = started.headers.location?.match(/^\/exam\/([\w-]+)$/)?.[1];
if (!attemptId) throw new Error(`Could not start the exam (${started.status} ${started.headers.location})`);
save(`/exam/${attemptId}`, await get(agents.you, `/exam/${attemptId}`));
const assets = path.join(root, 'demo', 'assets');
for (const [kind, file, mime] of [['face', 'sample-face.jpg', 'image/jpeg'], ['id', 'sample-id.jpg', 'image/jpeg'], ['room_scan', 'sample-room.webm', 'video/webm']]) {
  const body = await readFile(path.join(assets, file));
  await query('INSERT INTO proctor_media (attempt_id, kind, mime, byte_size, data) VALUES ($1, $2, $3, $4, $5)', [
    attemptId, kind, mime, body.length, encryptBuffer(body, { purpose: 'proctor-media', context: `${attemptId}:${kind}` }),
  ]);
}
const checkinPage = await get(agents.you, `/exam/${attemptId}`);
const csrf = checkinPage.body.toString().match(/data-csrf="([^"]+)"/)[1];
await agents.you.post(`/exam/${attemptId}/begin`).set('x-csrf-token', csrf).send({ confirm: true }).expect(200);
const live = await get(agents.you, `/exam/${attemptId}`);
files.set(`/exam/${attemptId}/live/`, { html: live.body.toString('utf8'), appPath: `/exam/${attemptId}/live` });
exported.add(`/exam/${attemptId}/live/`);
const paper = await get(agents.you, `/exam/${attemptId}/paper`);
files.set(`/exam/${attemptId}/paper.json`, { body: paper.body });
// Answer most questions correctly so the result screen shows a pass waiting for identity review.
const { question_ids: qids } = await one('SELECT question_ids FROM exam_attempts WHERE id = $1', [attemptId]);
for (const [i, qid] of qids.entries()) {
  const opts = await many('SELECT id, is_correct FROM question_options WHERE question_id = $1', [qid]);
  const pick = i % 12 === 5 ? [opts.find((o) => !o.is_correct).id] : opts.filter((o) => o.is_correct).map((o) => o.id);
  await agents.you.post(`/exam/${attemptId}/answer`).set('x-csrf-token', csrf).send({ questionId: qid, optionIds: pick }).expect(200);
}
await agents.you.post(`/exam/${attemptId}/submit`).set('x-csrf-token', csrf).set('Accept', 'application/json').send({}).expect(200);
const result = await get(agents.you, `/exam/${attemptId}/result`);
save(`/exam/${attemptId}/result`, result);

// ---------- Write ----------
const shared = {
  checkinUrl: published(`/exam/${attemptId}`),
  examUrl: published(`/exam/${attemptId}/live`),
  resultUrl: published(`/exam/${attemptId}/result`),
  paperUrl: `${BASE}/exam/${attemptId}/paper.json`,
  lobbyUrl: published(`/learn/${course.slug}/exam`),
  dashboardUrl: published('/dashboard'),
  adminUrl: published('/admin'),
  homeUrl: published('/'),
  verifyCode: demo.certCode,
  timeLimitMinutes: course.exam_time_limit_minutes,
  pages: [...exported].filter((p) => p.endsWith('/')),
  logins: { learner: people.you.email, admin: demo.admin.email },
};

console.log(`Writing ${files.size} files to ${OUT}`);
await rm(OUT, { recursive: true, force: true });
for (const [p, f] of files) {
  const file = path.join(OUT, p.endsWith('/') ? `${p}index.html` : p);
  await mkdir(path.dirname(file), { recursive: true });
  if (f.redirect) await writeFile(file, redirectPage(f.redirect));
  else if (f.html != null) await writeFile(file, rewriteHtml(f.html, f.appPath));
  else await writeFile(file, f.body);
}

// Static assets: the site's own files, the fonts the stylesheet uses, and the face detector.
await cp(path.join(root, 'public'), OUT, { recursive: true });
await cp(path.join(root, 'demo', 'static'), path.join(OUT, 'demo'), { recursive: true });
let css = await readFile(path.join(root, 'public', 'css', 'app.css'), 'utf8');
for (const [, font] of css.matchAll(/url\('\/fonts\/([^']+)'\)/g)) {
  const [family, file] = font.split('/');
  const pkg = { jost: '@fontsource/jost', 'plex-sans': '@fontsource/ibm-plex-sans', 'plex-mono': '@fontsource/ibm-plex-mono' }[family];
  await mkdir(path.join(OUT, 'fonts', family), { recursive: true });
  await cp(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file), path.join(OUT, 'fonts', family, file));
}
await writeFile(path.join(OUT, 'css', 'app.css'), css.replace(/url\('\//g, `url('${BASE}/`));
const faceApi = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
await mkdir(path.join(OUT, 'vendor', 'face-api', 'model'), { recursive: true });
await cp(path.join(faceApi, 'dist', 'face-api.esm.js'), path.join(OUT, 'vendor', 'face-api', 'face-api.esm.js'));
for (const f of ['tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model.bin']) {
  await cp(path.join(faceApi, 'model', f), path.join(OUT, 'vendor', 'face-api', 'model', f));
}
// Absolute paths inside the site's scripts.
for (const f of ['exam.js', 'exam-checkin.js', 'lesson.js', 'proctor.js', 'exam-proctor.js', 'admin-media.js', 'site.js']) {
  const file = path.join(OUT, 'js', f);
  const js = await readFile(file, 'utf8');
  await writeFile(file, js.replace(/([`'"])\/(exam|learn|vendor|dashboard|admin)\b/g, `$1${BASE}/$2`));
}
const manifest = JSON.parse(await readFile(path.join(OUT, 'site.webmanifest'), 'utf8'));
manifest.start_url = `${BASE}/`;
for (const icon of manifest.icons ?? []) icon.src = BASE + icon.src;
await writeFile(path.join(OUT, 'site.webmanifest'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
await writeFile(path.join(OUT, '.nojekyll'), '');
await writeFile(path.join(OUT, '404.html'), (await readFile(path.join(OUT, 'index.html'), 'utf8')));
console.log(`Done: ${exported.size} pages and files.`);
await pool.end();
