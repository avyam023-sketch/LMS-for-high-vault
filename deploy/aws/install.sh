#!/usr/bin/env bash
# Installs or updates the site on an AWS Lightsail Ubuntu server. Run from the repository folder:
#   sudo bash deploy/aws/install.sh
# First run: installs Node.js and Caddy, creates /etc/high-vault/env with new secrets, then stops so you
# can fill in the settings. Run it again after editing the settings, and after every `git pull`.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash deploy/aws/install.sh"; exit 1; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR=/opt/high-vault
CONF_DIR=/etc/high-vault
ENV_FILE=$CONF_DIR/env
SERVICE=high-vault

# ---------- 1. Packages (first run only) ----------
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Installing Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  echo "Installing Caddy (automatic HTTPS)…"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
id -u "$SERVICE" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE"

# ---------- 2. Settings (created once, never overwritten) ----------
install -d -m 750 -o root -g "$SERVICE" "$CONF_DIR"
curl -fsSL -o "$CONF_DIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
chmod 644 "$CONF_DIR/rds-global-bundle.pem"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO/deploy/aws/env.example" "$ENV_FILE"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')|; s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')|" "$ENV_FILE"
  chown root:"$SERVICE" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo
  echo "Created $ENV_FILE with new SESSION_SECRET and ENCRYPTION_KEY."
  echo "Back up ENCRYPTION_KEY in a password manager: without it, stored ID photos and two-step secrets can't be read."
  echo
  echo "Next: sudo nano $ENV_FILE   (APP_URL, DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, API keys)"
  echo "Then run this script again:  sudo bash deploy/aws/install.sh"
  exit 0
fi
if grep -q 'PASSWORD@ENDPOINT' "$ENV_FILE"; then
  echo "DATABASE_URL in $ENV_FILE still has the placeholder. Edit it (sudo nano $ENV_FILE) and run this again."
  exit 1
fi
APP_URL=$(grep -E '^APP_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')
DOMAIN=${APP_URL#https://}; DOMAIN=${DOMAIN%%/*}
[ -n "$DOMAIN" ] && [ "$DOMAIN" != "$APP_URL" ] || { echo "APP_URL must start with https:// (e.g. https://learn.thehighvaultsecurity.ca)"; exit 1; }

# ---------- 3. App code (a clean copy, owned by root, read-only to the service) ----------
echo "Installing the app into $APP_DIR…"
install -d -m 755 "$APP_DIR"
for item in package.json package-lock.json src views public scripts; do
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$REPO/$item" "$APP_DIR/"
done
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"

# ---------- 4. Service ----------
cat > /etc/systemd/system/$SERVICE.service <<UNIT
[Unit]
Description=The High Vault Security learning platform
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE
Group=$SERVICE
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --env-file=$ENV_FILE src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT

# ---------- 5. HTTPS (Caddy gets and renews the certificate automatically) ----------
cat > /etc/caddy/Caddyfile <<CADDY
# Written by deploy/aws/install.sh. The app sets its own security headers; Caddy terminates TLS and forwards.
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable --now $SERVICE >/dev/null
systemctl restart $SERVICE
systemctl reload caddy || systemctl restart caddy

echo "Waiting for the app to start…"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "Running. Open $APP_URL (the HTTPS certificate can take a minute the first time)."
    echo "Logs:  sudo journalctl -u $SERVICE -f"
    exit 0
  fi
  sleep 2
done
echo "The app didn't come up. See the logs:  sudo journalctl -u $SERVICE -n 80 --no-pager"
exit 1
