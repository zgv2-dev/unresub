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

Production: `pnpm --filter @unresub/web build && pnpm --filter @unresub/server start` (the server serves the built UI).

Connect monobank in the UI with a personal token from https://api.monobank.ua.

## Android app

CI (`.github/workflows/android.yml`) builds on every push to `main`, on PRs and on manual runs. APKs are in the run's **Artifacts**: `unresub-debug-*` installs straight away; `unresub-release-*` is signed only if the signing secrets exist.

One-time setup in GitHub repo settings:

1. **Variable** `UNRESUB_API_URL` (Settings → Secrets and variables → Actions → Variables): https URL of your server, e.g. `https://unresub.example.com`. Android blocks plain http. The server already allows CORS from the app.
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
