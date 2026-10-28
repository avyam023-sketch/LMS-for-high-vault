# Production on AWS Lightsail (Montreal)

One small server and a managed PostgreSQL database, both in **Canada (Montreal), ca-central-1**, so learner data and ID photos stay in Canada. Caddy handles HTTPS automatically.

```
learner ──HTTPS──▶ Caddy ──▶ app (Docker) ──TLS, verified──▶ Lightsail PostgreSQL
                   (Lightsail instance, static IP)             (automatic daily backups)
```

Allow about an hour the first time. You need: an AWS account, access to the domain's DNS, and the API keys you want to use (Resend, Stripe, Bunny Stream).

## 1. Database

1. Lightsail console → **Databases → Create database**.
2. Region **Canada (Montreal)**. Engine **PostgreSQL 16**. Plan **Standard** (pick High availability later if you need it).
3. Under *Specify login credentials*, keep the user `dbmasteruser` and let AWS create a strong password. Set the **master database name** to `highvault`.
4. Name it `highvault-db` and create it. It takes 10 to 15 minutes.
5. Open it → **Connect**. Copy the endpoint and the password; you'll need both in step 4.
6. Leave **Public mode** off. Only the server will connect.

## 2. Server

1. **Instances → Create instance**, region **Canada (Montreal)**, platform **Linux**, blueprint **OS only → Ubuntu 24.04 LTS**.
2. Plan: **2 GB RAM** is enough to start. Name it `highvault-web`.
3. After it starts: **Networking → Create static IP** and attach it to the instance.
4. **Networking → IPv4 firewall**: keep SSH (22), add **HTTPS (443)** and **HTTP (80)**. (HTTP is only used to redirect to HTTPS and to get the certificate.)
5. Turn on **automatic snapshots** for the instance (Snapshots tab).

## 3. Domain

At your DNS provider, add an **A record**, e.g. `learn.thehighvaultsecurity.ca` → the static IP. Wait until it resolves (`ping learn.thehighvaultsecurity.ca` shows the IP).

## 4. Install

Open the instance's browser terminal (**Connect using SSH**) and run:

```bash
git clone https://github.com/avyam023-sketch/LMS-for-high-vault.git
cd LMS-for-high-vault
bash deploy/aws/setup.sh
newgrp docker
nano deploy/aws/.env
```

In `.env`, fill in:

- `DOMAIN`: the address from step 3, without `https://`.
- `DATABASE_URL`: `postgres://dbmasteruser:PASSWORD@ENDPOINT:5432/highvault`, using the endpoint and password from step 1. If the password has symbols like `@`, `/` or `#`, URL-encode them. Don't add `?sslmode=…`: the app always uses TLS and checks the certificate against AWS's bundle.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: the first administrator.
- `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BUNNY_STREAM_TOKEN_KEY` as you have them.

Save (Ctrl+O, Enter, Ctrl+X), then start it:

```bash
docker compose -f deploy/aws/docker-compose.yml up -d --build
docker compose -f deploy/aws/docker-compose.yml logs -f app
```

When the log says `listening`, open `https://your-domain`. Sign in as the admin and set up two-step verification. Then remove `ADMIN_PASSWORD` from `.env` and run the `up -d` command again.

**Back up `ENCRYPTION_KEY`** (in `.env`) in a password manager. Without it, the encrypted ID photos, exam evidence and two-step secrets in the database can't be read.

## 5. Connect the services

- **Stripe** → Developers → Webhooks → *Add endpoint* `https://your-domain/webhooks/stripe`, with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` and `charge.refunded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
- **Resend** → Domains → add `thehighvaultsecurity.ca` and create the DNS records it shows. Emails are sent from `MAIL_FROM` once the domain shows *Verified*.
- **Bunny Stream** → your library → Security → turn on *Embed view token authentication* and copy the key into `BUNNY_STREAM_TOKEN_KEY`.

Admin → Overview shows a *Before going live* list until each of these is connected.

## Updating

```bash
cd LMS-for-high-vault
git pull
docker compose -f deploy/aws/docker-compose.yml up -d --build
```

Database changes run automatically when the app starts.

## Backups and restore

- The database has automatic daily backups (Lightsail keeps 7 days). Restore from **Databases → highvault-db → Snapshots & restore**, which creates a new database; point `DATABASE_URL` at it.
- Instance snapshots cover the server itself, including `.env`.
