# UnReSub

Personal subscription tracker. Connects to your bank, finds recurring payments, matches them to known services, and shows what's due next.

monobank only. Use a monobank USD/EUR card as the dedicated subscriptions card. Sources sit behind a `BankSource` interface (`packages/server/src/sources/`).

## Layout

- `packages/core`: bank-agnostic logic. Recurring-payment detection (`detect.ts`), known-service catalog (`catalog.ts`), money/period math (`money.ts`).
- `packages/server`: Hono API + SQLite (`node:sqlite`, no native deps). monobank adapter, sync scheduler, webhook endpoint, encrypted token storage.
- `packages/web`: React + Vite UI.
- `packages/mobile`: Android app. Capacitor wraps the web UI; native pieces (reminder notifications, bank notification parsing) go into `android/`.

## Self-hosting

UnReSub is a self-hosted app: one server, many people, each signing in with their own passkey (no passwords) and seeing only their own monobank data. Run the published image:

```sh
docker run -d -p 8787:8787 -v unresub-data:/data ghcr.io/zgv2-dev/unresub:latest
docker logs <container>   # shows the first-run setup code
```

Full guide (Compose, https, webhooks, backups, updating, Railway, moving from the single-user version): [docs/self-hosting.md](docs/self-hosting.md).

## Develop

```sh
pnpm install
pnpm dev               # API on :8787 (data in packages/server/data), UI on :5173
pnpm seed:demo [user]  # optional: fake bank data for an account you created
pnpm test
```

No `.env` is needed; see `.env.example` for the optional settings.

### Maintainer notes

- `.github/workflows/docker.yml` publishes `ghcr.io/zgv2-dev/unresub` on every push to `main` (`latest`) and on `v*.*.*` tags (semver). After the first run, make the package public once: GitHub → your profile → Packages → `unresub` → Package settings → Change visibility.
- The maintainer's own instance runs on Railway from this repo (`railway.json`), redeploying on each push to `main`.

## Android app

CI (`.github/workflows/android.yml`) builds on every push to `main`, on PRs and on manual runs. Each build on `main` is published as a GitHub Release `v0.1.<run>` with the APKs attached; the newest is always at **Releases → Latest** (`/releases/latest`). The debug APK installs straight away; the release APK is signed only if the signing secrets exist (otherwise it's named `-release-unsigned`). PR builds only keep the APKs as run artifacts.

One-time setup in GitHub repo settings:

The app asks for the server address on first start, so one APK works with any UnReSub server. Optionally set the repo **variable** `UNRESUB_API_URL` to prefill it.

1. **Secrets** for signing (needed for passkeys in the app: Android only lets an app use passkeys for a domain whose `assetlinks.json` lists the app's signing certificate, so the key must stay the same across builds):
   ```sh
   keytool -genkeypair -v -keystore unresub.jks -alias unresub -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 unresub.jks   # macOS: base64 -i unresub.jks
   ```
   Add `ANDROID_KEYSTORE_BASE64` (the base64 output), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`unresub`), `ANDROID_KEY_PASSWORD`. Keep the `.jks` file safe: updates must be signed with the same key. With the secrets set, both the debug and release APKs use this key, and the workflow's summary prints the certificate's SHA-256 fingerprint: set it as `UNRESUB_ANDROID_CERT_SHA256` on the server.

Local build (needs Android SDK + JDK 21): `cd packages/mobile && pnpm sync && cd android && ./gradlew assembleDebug`.

## How sync works

- monobank allows 1 statement request per minute and 31 days per request, so the first backfill of `BACKFILL_MONTHS` (default 12) takes about one minute per month per account. Newest windows load first.
- Incremental sync runs every `SYNC_INTERVAL_HOURS` (default 6). Every connected token syncs on its own with its own rate limiter, so one person's long backfill never delays another's.
- If `PUBLIC_URL` is set (https), a webhook is registered at `/hooks/<sourceId>/<secret>` and new transactions arrive instantly.

## Security

- Passkeys only (WebAuthn, user verification required). The relying-party id is the `PUBLIC_URL` host; the Android app's Credential Manager origin is accepted when its certificate is in `UNRESUB_ANDROID_CERT_SHA256`. Recovery is by one-time codes or an admin's single-use 24-hour link, both of which only allow adding a passkey. Browser sessions are httpOnly cookies with a CSRF token, the app uses a bearer session token. Only hashes of tokens and codes are stored.
- Each user has their own SQLite file (`users/<id>.db`) and their own data key, wrapped by the instance key (`UNRESUB_SECRET_KEY` or the generated `secret.key`). Bank tokens are encrypted with the user's key (AES-256-GCM), bound to their row id, and never returned by the API or logged.
- Admins manage accounts, not data: there is no endpoint that reads another user's database.
- The webhook URL carries a random secret, compared in constant time, and routes to exactly one user.
- Tests in `packages/server/src/auth.test.ts` check that one user can't read or change another's data through any endpoint.

## Detection

Debits are grouped by known service (catalog regexes) or a normalised merchant name, per charged currency. A series counts as a subscription when the median gap matches a period (weekly/monthly/quarterly/semiannual/annual), at least 60% of gaps fit it, and amounts stay within 25%. Apple and Google Play are split by price since they bill several subscriptions. The local (UAH) price uses the transaction's own UAH amount, so it reflects the rate at the time of the charge.

User edits (name, service, period, cancel URL, ignore) are stored as overrides keyed by the detection key and survive re-detection.

## Alerts (`packages/core/src/alerts.ts`, returned as `alerts` from `GET /api/subscriptions`)

- **upcoming_charge**: from `remindDays` (default 1) before the charge until the charge is detected. The UI banner can't be dismissed.
- **low_balance**: charges due on a subscriptions card in the next 3 days, summed in date order, that the card's own balance (credit limit ignored) won't cover. Charges in another currency are converted at today's monobank rates, rounded against you.
- **on_main_card**: once any card is marked as the subscriptions card, every live subscription billed from another card.

## Exchange rates

Charges where neither side is UAH (USD charge on the USD card) get their UAH value from the stored `/bank/currency` snapshot closest to the charge time. Snapshots are saved hourly at most, on each sync and webhook, so history before the first run uses the oldest snapshot.
