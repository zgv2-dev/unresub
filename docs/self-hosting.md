# Self-hosting UnReSub

One UnReSub server can serve a whole family or a group of friends. Each person signs in with their own passkey (there are no passwords) and connects their own monobank token; nobody, admins included, can see anyone else's cards or subscriptions.

What you need: something that runs a Docker container all the time, a persistent folder or volume for `/data`, and an https address. Passkeys only work over https (or on `localhost`), and monobank sends instant updates only to https.

## Quick start with Docker Compose

```sh
curl -O https://raw.githubusercontent.com/zgv2-dev/unresub/main/docker-compose.yml
docker compose up -d
docker compose logs unresub | grep -A3 "first-run setup"
```

Open your https address (or `http://localhost:8787` on the same machine), enter the setup code from the log, pick a username and create a passkey. Save the recovery codes it shows. Then connect monobank with a personal token from https://api.monobank.ua.

Plain Docker works the same way:

```sh
docker run -d --name unresub --restart unless-stopped -p 8787:8787 -v unresub-data:/data \
  -e PUBLIC_URL=https://unresub.example.com ghcr.io/zgv2-dev/unresub:latest
```

Images are built for `linux/amd64` and `linux/arm64` (a Raspberry Pi 4 or 5 works). Tags: `latest` follows `main`; `1`, `1.2` and `1.2.3` follow releases; `sha-<commit>` pins an exact build.

## Configuration

Nothing is required. All variables are optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | none | Public https address, e.g. `https://unresub.example.com`. Its host is the passkey domain, and it turns on monobank webhooks. Set it before anyone creates a passkey: passkeys are tied to this domain. |
| `UNRESUB_ANDROID_CERT_SHA256` | official app | Signing-certificate fingerprint of the Android app allowed to use passkeys here (comma-separate several). Published in `/.well-known/assetlinks.json`. See [Android app](#android-app). |
| `UNRESUB_ANDROID_PACKAGE` | `dev.unresub.app` | Package name for `assetlinks.json`, if you build the app under another id. |
| `PORT` | `8787` | Port the server listens on. |
| `DATA_DIR` | `/data` in Docker | Where all data lives. |
| `UNRESUB_SECRET_KEY` | generated | Instance key, 32 bytes base64 (`openssl rand -base64 32`). If unset, it's created once in `/data/secret.key`. |
| `UNRESUB_SETUP_CODE` | generated | Fixed first-run setup code instead of the one printed in the log. |
| `SYNC_INTERVAL_HOURS` | `6` | How often every connected bank is re-synced. |
| `BACKFILL_MONTHS` | `12` | How much history the first sync loads. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts without use. |

## Accounts and passkeys

There are no passwords. Everyone signs in with a passkey: Face ID or fingerprint on a phone, Windows Hello, a password manager such as 1Password or Bitwarden, or a security key.

- **First run.** Until an admin exists, the app shows a setup screen that needs the setup code from the server log. That stops a stranger who finds your address from claiming the server first.
- **Adding people.** Sign-up is invite-only by default: Account (the avatar) → **Invite someone** gives a one-use link valid for 7 days. Or switch on **Anyone with the link can sign up**. Opening the link lets the person pick a username and create a passkey.
- **More passkeys.** Account → **Add a passkey** for each device that doesn't sync passkeys with the others. Passkeys can be renamed and removed (never the last one).
- **Recovery codes.** Ten one-time codes are shown when the account is created. **Lost your passkey?** on the sign-in screen takes a username and one code, then asks for a new passkey; nothing else works until one is added. Account → **New recovery codes** replaces them.
- **Admin passkey link.** Someone lost their passkeys and their codes? An admin taps the key icon next to their name. The single-use link is valid 24 hours and only lets them add a new passkey.
- **Admins** can invite, remove people, make others admin and issue passkey links. They can't open anyone else's data.
- **Everyone** can export their data as JSON and delete their account (confirmed with a passkey).
- Browser sessions use an httpOnly cookie plus a CSRF token; the Android app gets its own revocable token. Failed sign-ins and wrong codes are throttled per account and per address.

## How data is kept apart

```
/data/
  secret.key          instance key (unless UNRESUB_SECRET_KEY is set)
  core.db             accounts, sessions, invites, webhook routing, public exchange rates
  users/<id>.db       one SQLite file per person: bank connections, transactions, subscriptions
```

Each person's bank data is a separate database file, so a request can only ever open the signed-in person's file. Each person also has their own data key, stored wrapped by the instance key, and their monobank token is encrypted with it (AES-256-GCM). Webhook URLs carry a random secret and map to exactly one person.

## https and a reverse proxy

Passkeys need https, monobank only sends webhooks to https addresses, and the Android app refuses plain http. Put the container behind any reverse proxy that terminates TLS and set `PUBLIC_URL` to the public address.

Caddy (gets certificates automatically):

```
unresub.example.com {
  reverse_proxy localhost:8787
}
```

nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

The server reads `X-Forwarded-Proto` to mark cookies Secure and the last `X-Forwarded-For` entry for login throttling, so keep exactly one proxy in front of it (Cloudflare Tunnel counts as that one).

Without `PUBLIC_URL`, everything still works; new transactions just show up on the next scheduled sync instead of instantly.

## Backups

Back up the whole `/data` folder, including `secret.key`. Without the key the saved monobank tokens can't be decrypted (people would have to paste them again; transactions and settings would still be there).

The simplest safe copy: stop the container for a moment, copy the folder, start it again.

```sh
docker compose stop unresub
docker run --rm -v unresub_unresub-data:/data -v "$PWD":/backup alpine tar czf /backup/unresub-$(date +%F).tgz -C /data .
docker compose start unresub
```

(The volume name is `<project>_unresub-data`; `docker volume ls` shows it.) On Railway, use the volume's **Backups** tab.

## Updating

```sh
docker compose pull && docker compose up -d
```

Database changes run automatically on start. Keep one replica only: SQLite files on a volume can't be shared between running copies.

## Railway

1. **New Project → Deploy from GitHub repo** with your fork, or **Deploy a Docker image** with `ghcr.io/zgv2-dev/unresub:latest`. If Railway offers one service per workspace package, keep only one (the server image already includes the web UI) and leave its root directory empty.
2. Attach a **volume** at `/data`.
3. **Settings → Networking → Generate Domain**, port `8787`.
4. Add the variable `PUBLIC_URL` = that https address.
5. Open **Deployments → View logs**, find the setup code, open the address and create the admin.

`railway.json` sets the health check (`/healthz`) and restart policy.

## Android app

Install the APK from the repository's [latest release](https://github.com/zgv2-dev/unresub/releases/latest). On first start it asks for your server address (for example `https://unresub.example.com`), then you sign in with a passkey like on the web. One app works with any UnReSub server.

The app creates and uses passkeys through Android's Credential Manager, which only allows it for a domain that vouches for the app. Your server does that by serving `/.well-known/assetlinks.json`, built from `UNRESUB_ANDROID_CERT_SHA256`:

- **Using the official APK:** nothing to do. The server lists the official app's certificate by default (`E1:B1:82:4B:…:AA:15`).
- **Building your own APK:** sign it with your own key (see the README) and set its fingerprint instead.
- Check it: `https://<your server>/.well-known/assetlinks.json` must show the fingerprint. Android caches this file, so after a change, clear the Google Play services cache or wait a day.

Without it the web app still works with passkeys; only the Android app can't sign in.

## Moving from the single-user version

Older versions kept everything in `/data/unresub.db` and used `UNRESUB_API_TOKEN`. When the new version starts with that file and no accounts, the setup screen says existing data was found. The old `UNRESUB_API_TOKEN` value works as the setup code (as does the code in the log). Creating the admin (with a passkey) then:

1. copies `unresub.db` to `unresub.db.pre-multiuser-<time>.bak`,
2. moves it to `users/<your id>.db`,
3. re-encrypts the monobank token with your new data key and re-registers the webhook.

Webhooks keep landing in the old file until you finish setup, so nothing is lost in between. After that, `UNRESUB_API_TOKEN` and `DB_PATH` can be removed.

Accounts made with a password before passkeys arrived: on the sign-in screen, tap **I had a password**. The password works once more, only to add a passkey, and is deleted right after.
