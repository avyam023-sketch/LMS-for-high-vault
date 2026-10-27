# The High Vault Security — Food Handler Certification

An online learning platform for The High Vault Security's food handler course. Learners create their own account and work through **10 modules, each a chapter (video and reading) followed by a quiz**. They then take a **proctored final exam** on camera with an ID check and a room scan, and receive a certificate employers can verify once the exam has been reviewed. Administrators manage everything from a built-in dashboard.

**Stack:** Node.js 22 · Express 5 · PostgreSQL 16 · server-rendered EJS · no front-end framework. It's a small, auditable codebase that runs anywhere Docker or Node runs.

| Course page | Module quiz | Exam check-in | Proctored exam | Identity review |
|---|---|---|---|---|
| ![Course page](docs/screenshots/course-page.png) | ![Quiz](docs/screenshots/quiz.png) | ![Check-in](docs/screenshots/checkin.png) | ![Exam](docs/screenshots/exam.png) | ![Review](docs/screenshots/admin-review.png) |

---

## What's included

### For learners
- **Course page** laid out like a product page: price box, what you'll learn, how it works, course outline, exam and certificate details, FAQ.
- **Self-registration** with email verification, password reset and optional two-step verification (authenticator app).
- **Course structure**: Module 1 → Chapter 1 → Module 1 quiz → Module 2 → … → Module 10 quiz → final exam. Everything unlocks strictly in order.
- **Chapters**: a video plus a written lesson, with a minimum study time tracked on the server. With a hosted MP4/WebM video, the learner must watch to the end before continuing. YouTube and Vimeo links also work, but viewing can't be tracked.
- **Module quizzes**: not timed or monitored. The learner must answer each question correctly to move on. A wrong answer is marked and they try again; a correct answer shows the explanation.
- **Proctored final exam**: a check-in before the timer starts (system check, face photo, ID photo, room-scan video). The camera and microphone stay on throughout, with snapshots, face monitoring, one-screen enforcement, full screen and focus monitoring. Questions are drawn at random, with autosave and a navigator.
- **Results** with a score and a per-topic breakdown. Individual answers are never shown, so they can't leak. A passed, proctored exam shows "certificate pending review" until an admin approves it.
- **PDF certificate** in the brand design, with a unique number (`HV-2026-XXXX-XXXX`) and a QR code.
- **Public verification page** (`/verify`): shows valid, expired or revoked.

### For administrators (`/admin`)
- **Overview**: learners, enrolments, certificates, 30-day pass rate, flagged exams, and exams waiting for identity review.
- **Identity review queue**: for each passed exam, the face photo and ID side by side with the name on file, the room-scan video, all snapshots (flagged moments highlighted) and the integrity timeline. **Approve** issues the certificate and emails the learner; **reject** voids the attempt and emails the reason.
- **Learners**: search; view progress, attempts, certificates and activity; verify an email; sign a user out everywhere; grant an extra attempt; enrol manually; correct a legal name; disable an account; promote to admin; reset 2-step.
- **Courses and exams**: edit the course page, price, exam rules and proctoring settings; add, edit and reorder modules and chapters (Markdown plus a video link).
- **Questions**: two banks — the **final-exam bank** (drawn at random) and **module quizzes** (fixed order, with explanations). Single or multiple answer, retire questions, **bulk-import from CSV** into either.
- **Exam attempts**: filter by flagged, live, passed, failed or voided. Each attempt shows every answer, the IP address, the browser and an integrity timeline. **Voiding** an attempt revokes its certificate.
- **Certificates**: search, revoke or reinstate, export to CSV.
- **Audit log** of sign-ins, admin changes and exam events.

---

## Anti-cheating measures

| Measure | How it works |
|---|---|
| Randomised exams | Each attempt draws questions at random from the bank, and answer options are shuffled per learner. A bank about twice the exam size makes shared answers much less useful. |
| Answer key never leaves the server | The browser receives only question text and option IDs. Grading happens server-side, and an automated test checks this. |
| Server-enforced time limit | Deadlines are stored in the database. Late answers are refused and expired attempts submit automatically. |
| Course before exam | The exam unlocks only when every chapter and module quiz is complete. Minimum study time is credited from real elapsed server time, so sending requests rapidly doesn't add time. |
| ID and face check | Before the exam, the learner photographs their face and holds government ID up to the camera. A reviewer compares both with the name on the account before any certificate is issued. |
| Room scan | A recorded video of at least 30 seconds, with sound: all walls, the desk, under the desk, and where the phone is. |
| Camera on throughout | The camera and microphone must stay on. Turning the camera off is a warning and blocks the exam until it's back. Snapshots are taken every 30 seconds and at every flagged moment. |
| No one else present | Self-hosted face detection runs in the browser and flags "no face for 8+ seconds" and "more than one person". Sustained talking or noise is flagged too. These go to the reviewer with snapshots and **don't** end the exam automatically, because lighting or a poster can fool detection. |
| One screen, a real computer | A second monitor blocks check-in and counts as a warning mid-exam (detected in Chrome and Edge, which the exam requires). Phones and tablets can't take the exam. |
| Human review | With identity review on (the default), certificates are issued only after an admin approves the recording. |
| Focus monitoring | Leaving the tab, leaving the window, exiting full screen, turning off the camera or connecting a second screen gives a warning. After N warnings (configurable), the exam submits itself and is flagged. |
| Full-screen mode | Required where the device supports it (configurable). |
| Copy, paste, print, right-click | Blocked and logged. Text selection is disabled. |
| Personal watermark | The learner's name and email are tiled behind the exam, which discourages sharing screenshots. |
| One device at a time | Signing in on a second device signs out the first, which stops account sharing. |
| One open attempt | Enforced by a database constraint, so a second tab or a double-click can't start a second attempt. |
| Attempt limits and cooldown | Configurable maximum attempts and a waiting period between them. |
| Identity | The learner confirms their legal name at sign-up and at exam start. The name locks once a certificate is issued, and only an admin can correct it. |
| Forgery-proof certificates | Every certificate can be checked online by number or QR code, and revocation shows up immediately. |

**Limitations, stated plainly:**
- Proctoring is recorded and reviewed afterwards, not watched live. A determined person could still use a device the camera can't see; the room scan, snapshots and human review make that hard, not impossible. Live remote proctoring would close the gap further.
- "Phones out of reach" and "quiet room" are confirmed by the learner's pledge and checked by the reviewer against the room scan. Software can't verify them directly.
- Face detection is a signal for the reviewer, not a verdict.

---

## Security

- **Passwords**: Argon2id hashing, at least 12 characters, a common-password blocklist and an optional Have I Been Pwned check (k-anonymity, so the password never leaves the server).
- **Sign-in**: the account locks for 15 minutes after 5 failed attempts. Wrong MFA codes count toward the same limit. Login timing doesn't reveal whether an email exists, and neither does registration or password reset.
- **Two-step verification (TOTP)**: required for admins, optional for learners. Secrets are encrypted at rest with AES-256-GCM, and used codes can't be replayed.
- **Sessions**: stored server-side in Postgres. The cookie is `HttpOnly`, `Secure` and `SameSite=Lax`, with the `__Host-` prefix in production. The session ID changes at login, there's an 8-hour idle timeout, and changing or resetting a password signs out other sessions.
- **CSRF**: a synchronizer token on every form and API call.
- **Headers** (Helmet): a strict Content-Security-Policy (no inline scripts or styles, no third-party scripts), HSTS, `frame-ancestors 'none'`, `nosniff`, a referrer policy and a permissions policy.
- **Input**: every input is validated with zod. All SQL is parameterised. Admin-written Markdown is sanitised against an allow-list. The CSV export guards against formula injection.
- **Rate limits** on sign-in, registration, email sending, certificate lookups and exam API calls.
- **Proctoring data**: ID photos, room scans and snapshots are checked by file signature on upload, encrypted with AES-256-GCM before they reach the database, served only to admins (never cached), and deleted automatically after `PROCTOR_RETENTION_DAYS` (default 90). Face detection uses a self-hosted model, so no images go to any third party. Camera and microphone are allowed only on this site by the permissions policy.
- **Least exposure**: the admin area returns 404 to anyone who isn't an admin. Nothing in the course content or question bank is publicly writable.
- **Audit trail** for authentication and every admin action.
- **Dependencies**: `npm audit` runs clean, and CI fails on high-severity advisories.

---

## Running it locally

Requirements: Node.js 22.12+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env            # then fill in SESSION_SECRET and ENCRYPTION_KEY (see comments in the file)
createdb highvault              # or point DATABASE_URL at any Postgres database
npm run seed                    # creates tables and loads the course: 10 modules, 10 chapters, 40 quiz questions, 46 exam questions
npm run create-admin -- you@yourdomain.ca "First" "Last"   # prints a one-time password
npm run dev                     # http://localhost:3000
```

Without `SMTP_URL`, verification and reset emails print to the server console.

The first time an admin signs in, they're asked to set up two-step verification before the dashboard opens.

### Tests

```bash
createdb highvault_test
cp .env .env.test               # set NODE_ENV=test and DATABASE_URL to the test database
npm test
```

The suite covers registration, verification, CSRF, the full learner journey through to a certificate, module quizzes (answer-until-correct, no skipping, unlock order), proctored check-in (required media, upload validation, encryption at rest, timer starting only at "begin", lapsed and cancelled check-ins), identity review, every anti-cheat rule, lockout, single-session enforcement, password reset, MFA (setup, sign-in and replay protection), admin access control, certificate revocation, CSV import and export, and XSS sanitisation.

---

## Deploying

The app is a single stateless container plus a PostgreSQL database.

```bash
docker compose up -d --build
docker compose exec app npm run seed
docker compose exec app npm run create-admin -- you@yourdomain.ca "First" "Last"
```

Any host that runs a container and managed Postgres works (Render, Railway, Fly.io, DigitalOcean App Platform, AWS, Azure). Checklist:

1. `NODE_ENV=production` and `APP_URL=https://your-domain`.
2. Generate fresh `SESSION_SECRET` and `ENCRYPTION_KEY` values. **Back up `ENCRYPTION_KEY`**: losing it means admins must re-enrol their two-step verification.
3. Set `TRUST_PROXY=1` (or the number of proxy hops) when behind a load balancer, so rate limits and logs see real client IPs.
4. Configure `SMTP_URL` with a transactional email provider (Postmark, SES, Mailgun, Resend…).
5. Serve over HTTPS only. The app sends HSTS in production.
6. Schedule daily database backups. Proctoring files live in the database, so allow roughly 2 MB per exam (deleted after the retention period).
7. Optional: to charge for the course, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, point a Stripe webhook at `https://your-domain/webhooks/stripe` (event `checkout.session.completed`), and set a price in Admin → Courses. Without Stripe, enrolment is free.

Rate-limit counters are kept in memory, which suits one app instance. If you run several instances, switch to a shared store (`rate-limit-postgresql` or Redis).

---

## Before going live: content checklist

- [ ] **Review the course content and question bank** with whoever is accountable for food safety training. The starter content follows Health Canada guidance and Ontario's Food Premises Regulation (O. Reg. 493/17), but provincial and municipal requirements vary.
- [ ] **Confirm recognition status.** If the course must be approved or recognised by a provincial program or local public health unit, get that confirmation first, then add it to the course page and FAQ. Until then, the FAQ deliberately tells learners to check with their employer or health unit.
- [ ] Set the price (Admin → Courses), support email (`SUPPORT_EMAIL`) and sending address (`MAIL_FROM`).
- [ ] **Add the 10 chapter videos.** Admin → Courses → each chapter → *Chapter video*. A direct `.mp4` link (for example from Cloudflare R2, Bunny Stream or S3) lets the platform require watching to the end; YouTube/Vimeo links play but can't be tracked.
- [ ] Grow the final-exam bank to at least about 60 questions (twice the 30-question exam) to reduce answer sharing.
- [ ] Decide who reviews exam recordings and how quickly, and tell learners (the result page says the certificate is issued after review).
- [ ] Have the privacy page (`views/public/privacy.ejs`) and the exam recording consent reviewed for your obligations under PIPEDA or provincial privacy law. **Collecting ID images and room video is sensitive.** Confirm the retention period and who may access recordings.

---

## Project layout

```
src/
  app.js              Express app: security headers, sessions, CSRF, routes
  server.js           Boots the app (runs migrations first)
  config.js           Validated environment configuration
  db/                 Pool, migrations, seed + starter course content
  lib/                Auth, exam engine, certificates (PDF), crypto, mail, validation
  routes/             public, auth, account, learn, exam, payments, admin
views/                EJS templates (public, auth, learn, admin, partials)
public/               CSS, client JS (exam engine, lesson timer), logo assets
test/                 End-to-end integration tests (node:test + supertest)
```
