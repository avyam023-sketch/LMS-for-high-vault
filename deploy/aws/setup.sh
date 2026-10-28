#!/usr/bin/env bash
# One-time setup on a fresh Lightsail Ubuntu instance. Run from the repository root:
#   bash deploy/aws/setup.sh
# Installs Docker, downloads the AWS database certificate bundle and creates deploy/aws/.env with new secrets.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Log out and back in (or run 'newgrp docker') before 'docker compose'."
fi

mkdir -p certs
echo "Downloading the AWS RDS certificate bundle (used to verify the database connection)…"
curl -fsSL -o certs/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
chmod 644 certs/global-bundle.pem

if [ ! -f .env ]; then
  cp env.example .env
  session=$(openssl rand -base64 48 | tr -d '\n')
  key=$(openssl rand -base64 32 | tr -d '\n')
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${session}|; s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${key}|" .env
  chmod 600 .env
  echo "Created deploy/aws/.env with new SESSION_SECRET and ENCRYPTION_KEY."
  echo "Back up ENCRYPTION_KEY somewhere safe: without it, stored ID photos and MFA secrets can't be read."
else
  echo "deploy/aws/.env already exists; left unchanged."
fi

echo
echo "Next: edit deploy/aws/.env (nano deploy/aws/.env): DOMAIN, DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD and the API keys."
echo "Then start the site:  docker compose -f deploy/aws/docker-compose.yml up -d --build"
