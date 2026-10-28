# Client demo site: set-up and walkthrough

A real, working copy of the site at a public address that the client can visit and try for themselves: register, get a 6-digit code by email, pay with a Stripe test card, study, take the proctored exam, and get a certificate once it's approved in the admin.

It runs exactly the production code, with the same security checks. It costs nothing:

| Piece | Service | Plan |
|---|---|---|
| The site | Render | Free |
| Database | Supabase, Canada region | Free |
| Email | Gmail (or Resend with a verified domain) | Free |
| Payments | Stripe | Test mode: test cards, no real money |

Setting it up takes about 30 minutes the first time. Go top to bottom. Every key you copy goes into Render's form in step 4, never into a chat or a document.

> The real site runs on AWS Montreal ([`deploy/aws/`](deploy/aws/README.md)). This demo is for showing the client, not for real learners: free plans sleep when idle and have no backups. Delete it when you're done.

---

## 1. Database: Supabase (8 minutes)

1. Go to [supabase.com](https://supabase.com) and sign up.
2. Click **New project**:
   - **Name:** `high-vault-demo`
   - **Database password:** click *Generate a password*, then copy it into a note. You need it in a moment.
   - **Region:** **Canada (Central)**
3. Wait about 2 minutes for the project to finish setting up.
4. Click **Connect** at the top of the project.
   - Open the **Session pooler** connection string. Don't use *Direct connection* or *Transaction pooler*.
   - Copy it. It looks like `postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`.
   - Replace `[YOUR-PASSWORD]` (square brackets too) with the password from step 2. This is your **`DATABASE_URL`**.
5. Go to **Project Settings → Database → SSL Configuration** and click **Download certificate**.
   - Open the file in Notepad or TextEdit.
   - Copy everything from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`. This is your **`DATABASE_CA_CERT`**. It isn't a secret; it lets the site check it's talking to the real database.

## 2. Email (5 minutes)

The site won't start without a way to send email, because learners need their confirmation codes. Pick one.

### Option A: Gmail (no domain needed, sends to anyone)

Best for the demo. Use a Gmail account made for the business, not a personal one.

1. Sign in to that Gmail account and turn on **2-Step Verification** at [myaccount.google.com/security](https://myaccount.google.com/security).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create an app password named `high-vault-demo`, and copy the 16 letters (without the spaces).
3. Build your **`SMTP_URL`**, replacing the address and the 16 letters:
   ```
   smtps://highvault.demo%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465
   ```
   The `@` in the Gmail address must be written as `%40`.
4. Your **`MAIL_FROM`** is `THVFoodSafe <highvault.demo@gmail.com>` (with your address).

Gmail sends up to about 500 emails a day, plenty for a demo.

### Option B: Resend (needs the domain)

Only if you can add DNS records for `thehighvaultsecurity.ca`. Sign up at [resend.com](https://resend.com), verify the domain under **Domains**, then **API Keys → Create API key** (Sending access). The `re_…` key is your **`RESEND_API_KEY`**, and **`MAIL_FROM`** is `THVFoodSafe <no-reply@thehighvaultsecurity.ca>`. Without a verified domain, Resend only delivers to your own address, so the client would never get a code.

## 3. Payments: Stripe test mode (4 minutes)

1. Go to [dashboard.stripe.com/register](https://dashboard.stripe.com/register) and sign up. You don't need to activate the account for test mode.
2. Make sure you're in **test mode** (a *Test mode* or *Sandbox* label at the top).
3. Go to **Developers → API keys** and reveal the **Secret key** (`sk_test_…`). This is your **`STRIPE_SECRET_KEY`**. Never use an `sk_live_` key here.

## 4. The site: Render (10 minutes)

1. Go to [render.com](https://render.com) and **sign in with GitHub**. When asked, allow access to `avyam023-sketch/LMS-for-high-vault`.
2. Click **New → Blueprint** and pick the repository, branch `claude/vibrant-volta-u9jfww` (the repo's default branch).
3. Render shows the values it needs. Fill them in:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Session pooler string from step 1.4 |
   | `DATABASE_CA_CERT` | Certificate text from step 1.5 |
   | `ADMIN_EMAIL` | Your admin sign-in email |
   | `ADMIN_PASSWORD` | A long passphrase (12+ characters) that doesn't contain your email |
   | `SMTP_URL` | From step 2, option A (leave blank if you use Resend) |
   | `RESEND_API_KEY` | From step 2, option B (leave blank if you use Gmail) |
   | `MAIL_FROM` | From step 2 |
   | `STRIPE_SECRET_KEY` | `sk_test_…` from step 3 |
   | `STRIPE_WEBHOOK_SECRET` | Leave blank for now (step 6) |
   | `BUNNY_STREAM_TOKEN_KEY` | Leave blank |

4. Click **Apply**. The first build takes 5 to 8 minutes. Watch **Logs**. It's ready when you see:
   ```
   [bootstrap] Created administrator …
   THVFoodSafe listening on …
   ```
   If it says **Refusing to start in production** instead, the lines under it say exactly which setting to fix.
5. Your site's address is at the top of the Render page, like `https://high-vault-lms.onrender.com`. Open it and **Sign in** with the admin email and passphrase. You'll be asked to set up two-step verification: scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) and enter the code.
6. In Render → the service → **Environment**, delete `ADMIN_PASSWORD` and save. The admin account stays; the password just no longer sits in the settings.

## 5. Make the course quick to walk through (2 minutes, demo only)

Each chapter has a minimum study time (over an hour in total), so the client would wait a long time to reach the final exam. On the demo database only, shorten it:

1. In Supabase, open **SQL Editor → New query**.
2. Paste and click **Run**:
   ```sql
   UPDATE lessons SET min_seconds = 15;
   ```

Never run this on the real site's database. To change the times one by one instead, use **Admin → Courses →** a chapter → *Minimum study time*.

## 6. Refunds (optional, 3 minutes)

The site already confirms payments without this. Add it to show refunds.

1. In Stripe: **Developers → Webhooks → Add endpoint**.
   - **Endpoint URL:** `https://YOUR-RENDER-ADDRESS/webhooks/stripe`
   - **Events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`
2. Copy the **Signing secret** (`whsec_…`) into Render → Environment → `STRIPE_WEBHOOK_SECRET`, and save. Render restarts the site.

---

## Sharing it with the client

Send them the address and these notes:

- **Create your own account** with **Register**. A 6-digit code arrives by email.
- **Pay with Stripe's test card** `4242 4242 4242 4242`, any future expiry date, any 3-digit CVC, any postal code. No money moves.
- **For the final exam**, use a laptop with a camera, in Chrome or Edge.
- **The first visit can take up to a minute** while the free server wakes up.

**To let the client see the admin side too:** ask them to register a second account with another email address. In your admin, open **Learners →** that account **→ Make admin** (or **Make identity reviewer** to show only the exam review queue). They'll set up two-step verification on their next sign-in. Take the access away afterwards with **Remove staff access**.

If a code email doesn't arrive, open the learner in the admin and click **Mark email verified**.

## The walkthrough (about 15 minutes)

Use two windows: a normal one signed in as admin, and a **private/incognito window** for the learner.

1. **The website.** In the private window, open the site. Scroll through the course, modules, pricing and FAQ. The policy pages are in the footer.
2. **Register** and fill in the sign-up cards.
3. **Email code.** Type the 6-digit code into the page, or click the button in the email. A welcome email follows with the learner ID (`HV-L-…`).
4. **Buy the course.** Click **Enrol**. Stripe's checkout opens. Pay with the test card. You come back to Module 1, enrolled, and a *Payment received* email arrives (`HV-P-…`).
5. **Study.** Open each chapter and its quiz. Answers must be right to move on, and modules unlock in order. With step 5 done, each chapter needs only 15 seconds.
6. **Proctored exam.** Start the final exam and allow the camera. Take the face photo, ID photo and room scan, then answer the timed questions. Switching tabs is logged as an integrity event, so it's worth showing once.
7. **Review.** In the admin window: **Exam attempts → Needs review**. Open the attempt, look at the ID, face, room scan and snapshots, then **Approve**.
8. **Certificate.** The learner gets a certificate email and downloads the PDF from *My learning*. Paste its number into **Verify** (top menu) to show the public check an employer would use.
9. **Find anything by reference.** In the admin, type any `HV-…` code (learner, exam, payment or certificate) into the search box on the left.
10. **Refund (if you did step 6).** In Stripe test mode, open the payment and **Refund** it in full. The learner loses access and gets a refund email.

## Keeping it running

- **The free site sleeps** after 15 minutes idle; the next visit takes up to a minute.
- **Supabase pauses** a free project after 7 days without activity. If it's been a while, open the project in Supabase and click **Restore**.
- **Admin → Overview → Before going live** shows payments as *Stripe test mode* and videos as still to do. That's expected for the demo.

## If something goes wrong

| What you see | Fix |
|---|---|
| Logs say **Refusing to start in production** | Fix each setting listed under it, then **Manual Deploy → Deploy latest commit**. |
| Logs say `unable to verify the first certificate` | `DATABASE_CA_CERT` is incomplete. Paste the whole certificate, including the BEGIN and END lines. |
| Logs say `password authentication failed` | `DATABASE_URL` still has `[YOUR-PASSWORD]`, or the password has symbols. URL-encode them: `@` → `%40`, `#` → `%23`, `/` → `%2F`. |
| Logs say `ADMIN_PASSWORD rejected` | The passphrase is too short or contains the email. Set a new one and redeploy. |
| Logs say `[mail] failed` with `Invalid login` | The Gmail app password or the `%40` in `SMTP_URL` is wrong. Create a new app password and try again. |
| The code email doesn't arrive | Check the spam folder. In the admin, open the learner → **Mark email verified**. |
| *Online payment isn't available right now* | `STRIPE_SECRET_KEY` is missing or isn't a valid `sk_test_…` key. |
| The camera doesn't start | Use Chrome or Edge on a laptop, allow the camera when asked, and close other apps using it (Zoom, Teams). |

## After the demo

Delete the Render service and the Supabase project (and the Gmail app password) when you no longer need them. Nothing from the demo carries over to the real site.
