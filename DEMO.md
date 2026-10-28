# Working demo: set-up and walkthrough

A real, working copy of the site at a public address, for showing the client everything end to end. A learner registers, gets a 6-digit code by email, pays with a Stripe test card, studies, takes the proctored exam, and gets a certificate after you approve it in the admin.

It costs nothing to run:

| Piece | Service | Plan |
|---|---|---|
| The site | Render | Free |
| Database | Supabase, Canada region | Free |
| Email | Resend | Free |
| Payments | Stripe | Test mode: test cards, no real money |

Setting it up takes about 30 minutes the first time. Keep this page open and go top to bottom. Every key you copy goes into Render's form in step 4, never into a chat or a document.

> Production runs on AWS Montreal instead ([`deploy/aws/`](deploy/aws/README.md)). This demo is for showing the client, not for real learners: free plans sleep when idle and have no backups.

---

## 1. Database: Supabase (8 minutes)

1. Go to [supabase.com](https://supabase.com) and sign up.
2. Click **New project**:
   - **Name:** `high-vault-demo`
   - **Database password:** click *Generate a password*, then copy it into a note. You need it in step 3.
   - **Region:** **Canada (Central)**
3. Wait about 2 minutes for the project to finish setting up.
4. Click **Connect** at the top of the project.
   - Open the **Session pooler** connection string. Don't use *Direct connection* or *Transaction pooler*.
   - Copy the string. It looks like `postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`.
   - Replace `[YOUR-PASSWORD]` with the password from step 2 (remove the square brackets too). This is your **`DATABASE_URL`**.
5. Go to **Project Settings → Database → SSL Configuration** and click **Download certificate**.
   - Open the file in a text editor (Notepad or TextEdit).
   - Copy everything from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`. This is your **`DATABASE_CA_CERT`**. It isn't a secret; it lets the site check it's talking to the real database.
6. Optional: **Project Settings → Data API**, turn it off. The site never uses it and already blocks it, so this is a second lock.

## 2. Email: Resend (4 minutes)

1. Go to [resend.com](https://resend.com) and sign up **with the email address you'll register with during the demo**. Until a domain is verified, Resend only delivers to this one address.
2. Go to **API Keys → Create API key**, name it `high-vault-demo` and choose **Sending access**.
3. Copy the key (`re_…`). This is your **`RESEND_API_KEY`**. It's shown only once.

To send to anyone (the client, real learners), verify `thehighvaultsecurity.ca` under **Domains** in Resend. That means adding the DNS records it shows at the domain provider. Then set `MAIL_FROM` in Render to `The High Vault Security <no-reply@thehighvaultsecurity.ca>`.

## 3. Payments: Stripe test mode (4 minutes)

1. Go to [dashboard.stripe.com/register](https://dashboard.stripe.com/register) and sign up. You don't need to activate the account for test mode.
2. Make sure you're in **test mode** (a *Test mode* or *Sandbox* label at the top).
3. Go to **Developers → API keys** and reveal the **Secret key** (`sk_test_…`). This is your **`STRIPE_SECRET_KEY`**.

## 4. The site: Render (10 minutes)

1. Go to [render.com](https://render.com) and **sign in with GitHub**. When asked, allow access to `avyam023-sketch/LMS-for-high-vault`.
2. Click **New → Blueprint** and pick the repository.
   - **Branch:** `claude/vibrant-volta-u9jfww`. This work isn't on `main` yet; once it's merged, use `main`.
3. Render shows the values it needs. Fill them in:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Session pooler string from step 1.4 |
   | `DATABASE_CA_CERT` | Certificate text from step 1.5 |
   | `ADMIN_EMAIL` | Your admin sign-in email. Use a **different** address from your Resend one, so you can be admin and learner at once |
   | `ADMIN_PASSWORD` | A long passphrase (12+ characters) that doesn't contain your email |
   | `RESEND_API_KEY` | `re_…` from step 2 |
   | `STRIPE_SECRET_KEY` | `sk_test_…` from step 3 |
   | `STRIPE_WEBHOOK_SECRET` | Leave blank for now (step 5) |
   | `BUNNY_STREAM_TOKEN_KEY` | Leave blank |

4. Click **Apply**. The first build takes 5 to 8 minutes. Watch **Logs**. It's ready when you see:
   ```
   [bootstrap] Created administrator …
   [bootstrap] Loaded sample learners. …
   High Vault Academy listening on https://high-vault-lms.onrender.com
   ```
5. Open the address. Click **Sign in** with the admin email and passphrase. You'll be asked to set up two-step verification: scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) and enter the code.
6. In Render → the service → **Environment**, delete `ADMIN_PASSWORD` and save. The admin account stays; the password just no longer sits in the settings.

## 5. Refunds in the demo (optional, 3 minutes)

The site already confirms payments without this. Add it to show refunds, or bank payments that take time to clear.

1. In Stripe: **Developers → Webhooks → Add endpoint**.
   - **Endpoint URL:** `https://YOUR-RENDER-ADDRESS/webhooks/stripe`
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`
2. Copy the **Signing secret** (`whsec_…`) into Render → Environment → `STRIPE_WEBHOOK_SECRET`, and save. Render restarts the site.

---

## Before the meeting

- **Wake the site up.** Open it 2 minutes early: the free plan sleeps after 15 minutes idle, and the first visit takes about 30 seconds.
- **Supabase pauses after 7 days of no activity.** If it's been a while, open the project in Supabase and click **Restore**.
- **Use a laptop with a camera, in Chrome or Edge**, for the exam part. Have your phone (authenticator app) and your Resend email inbox open.
- **Admin → Overview** has a *Before going live* list. In the demo it shows payments (test mode) and videos as still to do, which is expected.

## The walkthrough (about 15 minutes)

Use two windows: a normal window signed in as admin, and a **private/incognito window** for the learner.

1. **The website.** In the private window, open the site. Scroll through the course, modules, pricing and FAQ. The policy pages are in the footer.
2. **Register.** Click **Register** and fill in the sign-up cards using **your Resend email**.
3. **Email code.** The confirmation email arrives within a few seconds. Type the 6-digit code into the page, or click the button in the email. A welcome email follows with the learner ID (`HV-L-…`).
4. **Buy the course.** Click **Register now** on the pricing card. Stripe's checkout opens. Pay with:
   - Card `4242 4242 4242 4242`
   - Any future expiry date, any 3-digit CVC, any postal code

   You come back to Module 1, enrolled. A *Payment received* email arrives with the payment reference (`HV-P-…`).
5. **Study.** Open Chapter 1 and its quiz. Answers must be right to move on, and modules unlock in order.
6. **Skip ahead (demo only).** In the admin window: **Learners →** your learner **→ Mark course complete (demo)**. Back in the learner window, refresh: the final exam is unlocked.
7. **Proctored exam.** Start the final exam and allow the camera. Take the ID photo, face photo and room scan, then answer the timed questions. Switching tabs is logged as an integrity event, so it's worth showing once.
8. **Review.** In the admin window: **Exam attempts → Needs review**. Open the attempt, look at the ID, face, room scan and snapshots, then **Approve**.
9. **Certificate.** The learner gets a certificate email. They download the PDF from *My learning*. Paste its number into **Verify** (top menu) to show the public check an employer would use.
10. **Find anything by reference.** In the admin, type any `HV-…` code (learner, exam, payment or certificate) into the search box on the left.
11. **Refund (if you did step 5).** In Stripe test mode, open the payment and **Refund** it in full. The learner loses access and gets a refund email.

## If something goes wrong

| What you see | Fix |
|---|---|
| Build fails or logs say `unable to verify the first certificate` | `DATABASE_CA_CERT` is incomplete. Paste the whole certificate, including the BEGIN and END lines. |
| Logs say `password authentication failed` | `DATABASE_URL` still has `[YOUR-PASSWORD]`, or the password has symbols. URL-encode symbols: `@` → `%40`, `#` → `%23`, `/` → `%2F`. |
| Logs say `ADMIN_PASSWORD rejected` | The passphrase is too short or contains the email. Set a new one and redeploy. |
| The code email doesn't arrive | You registered with an address other than your Resend login. Check Resend → **Logs**. Either use that address, or in the admin open the learner → **Mark email verified**. |
| *Online payment isn't available right now* | `STRIPE_SECRET_KEY` is missing or isn't a valid `sk_test_…` key. |
| *We couldn't open the payment page* | Stripe refused the request. Render → Logs shows why (usually a mistyped key). |
| The camera doesn't start | Use Chrome or Edge on a laptop, allow the camera when asked, and close other apps using it (Zoom, Teams). |

## After the demo

- **Admin → Overview → Remove sample data** clears the fictional learners, exams and certificates.
- Set `SEED_SAMPLE_DATA` to `false` in Render to hide the demo shortcut.
- Pause or delete the Render service and Supabase project when you no longer need them.
