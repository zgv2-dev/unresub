# UnReSub

Personal subscription tracker. Connects to your bank, finds recurring payments, matches them to known services, and shows what's due next.

monobank only. Use a monobank USD/EUR card as the dedicated subscriptions card. Sources sit behind a `BankSource` interface (`packages/server/src/sources/`).

## Layout

- `packages/core`: bank-agnostic logic. Recurring-payment detection (`detect.ts`), known-service catalog (`catalog.ts`), money/period math (`money.ts`).
- `packages/server`: Hono API + SQLite (`node:sqlite`, no native deps). monobank adapter, sync scheduler, webhook endpoint, encrypted token storage.
- `packages/web`: React + Vite UI.
- `packages/mobile`: Android app. Capacitor wraps the web UI; native pieces (reminder notifications, bank notification parsing) go into `android/`.

## Run

```sh
pnpm install
cp .env.example .env   # fill UNRESUB_SECRET_KEY and UNRESUB_API_TOKEN
pnpm seed:demo         # optional: fake data, no bank token needed
pnpm dev               # API on :8787, UI on :5173
```

Production without Docker: `pnpm --filter @unresub/web build && pnpm --filter @unresub/server build && pnpm --filter @unresub/server start:prod` (the server serves the built UI). With Docker: `docker build -t unresub . && docker run -p 8787:8787 -v unresub-data:/data --env-file .env unresub`.

Connect monobank in the UI with a personal token from https://api.monobank.ua.

## Hosting on Railway

The server must run all the time (scheduled sync, monobank webhooks) and keep its SQLite file on a persistent disk. Railway builds the `Dockerfile` using `railway.json` (health check on `/healthz`, restart on failure), gives you a free `https://….up.railway.app` address, and redeploys on every push to `main`.

Cost (not verified, check https://railway.com/pricing): there is a one-time trial credit, then the Hobby plan is about $5/month including $5 of usage, which should cover this small server. Railway may ask for a card to leave the trial.

One-time setup:

1. **Make two secrets** on your computer and save them in a password manager. Losing `UNRESUB_SECRET_KEY` means re-entering the monobank token.
   ```sh
   openssl rand -base64 32   # UNRESUB_SECRET_KEY
   openssl rand -hex 24      # UNRESUB_API_TOKEN (you type this into the web UI and the app)
   ```
2. **Create the project.** Sign in at https://railway.com with GitHub → **New Project** → **Deploy from GitHub repo** → pick `zgv2-dev/unresub` (allow the Railway GitHub app access to it if asked).

   Railway sees the pnpm workspace and offers **four services** (`@unresub/web`, `@unresub/core`, `@unresub/server`, `@unresub/mobile`). You need **only one**: the server image already contains the web UI, `core` is a library, and `mobile` is built by GitHub Actions. Before pressing **Deploy**:
   - Delete `@unresub/web`, `@unresub/core` and `@unresub/mobile`: tap each → **Settings** → bottom of the page → **Delete service**.
   - Open `@unresub/server` → **Settings** and fix what Railway pre-filled for the package folder:
     - **Source → Root Directory**: empty (repo root), not `packages/server`, if your Railway shows this field. Some accounts don't show it; then the next setting is enough.
     - **Build → Builder**: `Dockerfile`, **Dockerfile path** `/Dockerfile` (`railway.json` sets these too). Clear any custom build or start command.
     - **Watch Paths**: empty (`railway.json` provides them).
     - Optional: rename the service to `unresub`.
   - Do steps 3 and 4 below, then press **Deploy**.

   If it gets messy: ⋮ next to Deploy → discard the changes, then **Create → Empty Service** → its **Settings → Source → Connect Repo** → `zgv2-dev/unresub`, root directory empty.
3. **Add a volume** to that one service. On a computer: right-click the service on the canvas → **Attach volume**. On a phone: **Create** (or `Ctrl/⌘ K`) → **Volume** → choose the service. Mount path `/data`. The database lives at `/data/unresub.db`.
4. **Set variables.** Service → **Variables**:
   - `UNRESUB_SECRET_KEY`, `UNRESUB_API_TOKEN`: from step 1
   - `PORT` = `8787`
   - optional: `SYNC_INTERVAL_HOURS` (default 6), `BACKFILL_MONTHS` (default 12)
   - `DB_PATH`: don't set it, or set it to `/data/unresub.db`. Anything else (like `./unresub.db`) puts the database outside the volume and it's wiped on every deploy.

   Railway may suggest variables from `.env.example`; accept the two secrets and skip the rest.
5. **Get a public address.** Service → **Settings** → **Networking** → **Generate Domain**, target port `8787`. You get something like `https://unresub-production.up.railway.app`.
   Own domain instead: **Networking** → **Custom Domain** → e.g. `unresub.example.com`, port `8787`, then add the CNAME record Railway shows at your DNS provider. Railway issues the https certificate once DNS resolves.
6. **Turn on webhooks.** Add the variable `PUBLIC_URL` = that https address. Railway redeploys. The deploy is healthy when **Deployments** shows it as active; `https://<your address>/healthz` answers `ok`.
7. **Use it.** Open the address, enter `UNRESUB_API_TOKEN`, then connect monobank with a token from https://api.monobank.ua.
8. **Point the Android app at it.** GitHub repo → Settings → Secrets and variables → Actions → **Variables** → `UNRESUB_API_URL` = the same https address. Then Actions → Android → **Run workflow** to build an APK that talks to your server.

After that, every push to `main` that touches the server, web UI or `Dockerfile` redeploys (see `watchPatterns` in `railway.json`). Pushes that only change the Android app don't. Keep the service at one replica: SQLite on a volume can't be shared.

### Fallback: Fly.io

Same image, also needs a card. Install `flyctl`, then:

```sh
fly launch --no-deploy                       # uses the Dockerfile; say no to databases
fly volumes create unresub_data --size 1 --region waw
fly secrets set UNRESUB_SECRET_KEY=… UNRESUB_API_TOKEN=… PUBLIC_URL=https://<app>.fly.dev
```

In the generated `fly.toml`, set `internal_port = 8787`, `auto_stop_machines = "off"`, `min_machines_running = 1` under `[http_service]`, and add:

```toml
[mounts]
  source = "unresub_data"
  destination = "/data"
```

Then `fly deploy`. Use `https://<app>.fly.dev` as `UNRESUB_API_URL`.

## Android app

CI (`.github/workflows/android.yml`) builds on every push to `main`, on PRs and on manual runs. Each build on `main` is published as a GitHub Release `v0.1.<run>` with the APKs attached; the newest is always at **Releases → Latest** (`/releases/latest`). The debug APK installs straight away; the release APK is signed only if the signing secrets exist (otherwise it's named `-release-unsigned`). PR builds only keep the APKs as run artifacts.

One-time setup in GitHub repo settings:

1. **Variable** `UNRESUB_API_URL` (Settings → Secrets and variables → Actions → Variables): https URL of your server, e.g. `https://unresub-production.up.railway.app` (see [Hosting on Railway](#hosting-on-railway)). Android blocks plain http. The server already allows CORS from the app.
2. **Secrets** for a signed release (optional; debug builds work without them):
   ```sh
   keytool -genkeypair -v -keystore unresub.jks -alias unresub -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 unresub.jks   # macOS: base64 -i unresub.jks
   ```
   Add `ANDROID_KEYSTORE_BASE64` (the base64 output), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`unresub`), `ANDROID_KEY_PASSWORD`. Keep the `.jks` file safe: updates must be signed with the same key.

Local build (needs Android SDK + JDK 21): `cd packages/mobile && VITE_API_BASE=https://… pnpm sync && cd android && ./gradlew assembleDebug`.

## How sync works

- monobank allows 1 statement request per minute and 31 days per request, so the first backfill of `BACKFILL_MONTHS` (default 12) takes about one minute per month per account. Newest windows load first.
- Incremental sync runs every `SYNC_INTERVAL_HOURS` (default 6).
- If `PUBLIC_URL` is set (https), a webhook is registered at `/hooks/<sourceId>/<secret>` and new transactions arrive instantly.

## Security

- Bank tokens are encrypted with AES-256-GCM (`UNRESUB_SECRET_KEY`), bound to their row id, and never returned by the API or logged.
- The API requires `Authorization: Bearer $UNRESUB_API_TOKEN`.
- The webhook URL carries a random secret, compared in constant time.

## Detection

Debits are grouped by known service (catalog regexes) or a normalised merchant name, per charged currency. A series counts as a subscription when the median gap matches a period (weekly/monthly/quarterly/semiannual/annual), at least 60% of gaps fit it, and amounts stay within 25%. Apple and Google Play are split by price since they bill several subscriptions. The local (UAH) price uses the transaction's own UAH amount, so it reflects the rate at the time of the charge.

User edits (name, service, period, cancel URL, ignore) are stored as overrides keyed by the detection key and survive re-detection.

## Alerts (`packages/core/src/alerts.ts`, returned as `alerts` from `GET /api/subscriptions`)

- **upcoming_charge**: from `remindDays` (default 1) before the charge until the charge is detected. The UI banner can't be dismissed.
- **low_balance**: charges due on a subscriptions card in the next 3 days, summed in date order, that the card's own balance (credit limit ignored) won't cover. Charges in another currency are converted at today's monobank rates, rounded against you.
- **on_main_card**: once any card is marked as the subscriptions card, every live subscription billed from another card.

## Exchange rates

Charges where neither side is UAH (USD charge on the USD card) get their UAH value from the stored `/bank/currency` snapshot closest to the charge time. Snapshots are saved hourly at most, on each sync and webhook, so history before the first run uses the oldest snapshot.
