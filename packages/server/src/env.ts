import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Signing certificate of the official Android app (GitHub Releases). Public, not a secret. */
const OFFICIAL_APP_CERT = 'E1:B1:82:4B:A5:63:35:64:3A:53:B7:B6:9C:56:55:C6:2F:B0:F1:B4:A6:B7:36:29:69:86:EA:13:85:A8:AA:15';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

// DATA_DIR holds everything: core.db, users/<id>.db, secret.key. Older setups only set DB_PATH
// (the single-user database), so its folder is the data dir and the file is migrated on setup.
const legacyDbPath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : null;
const dataDir = resolve(process.env.DATA_DIR ?? (legacyDbPath ? dirname(legacyDbPath) : './data'));

export const env = {
  dataDir,
  /** The pre-multi-user database; claimed by the first admin during setup. */
  legacyDbPath: legacyDbPath ?? join(dataDir, 'unresub.db'),
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || null,
  port: num(process.env.PORT, 8787),
  syncIntervalHours: num(process.env.SYNC_INTERVAL_HOURS, 6),
  backfillMonths: num(process.env.BACKFILL_MONTHS, 12),
  /** Optional fixed setup code (otherwise one is generated and logged). The old UNRESUB_API_TOKEN also works. */
  setupCodes: [process.env.UNRESUB_SETUP_CODE, process.env.UNRESUB_API_TOKEN].filter((v): v is string => !!v),
  sessionDays: num(process.env.SESSION_DAYS, 30),
  /** Android app allowed to use passkeys for this domain (served in /.well-known/assetlinks.json). */
  androidPackage: process.env.UNRESUB_ANDROID_PACKAGE || 'dev.unresub.app',
  /**
   * SHA-256 signing-certificate fingerprints of that app, comma-separated (AB:CD:...). Defaults to the
   * official APK from github.com/zgv2-dev/unresub releases; set it to '' to turn the app off, or to your own build's key.
   */
  androidCertFingerprints: (process.env.UNRESUB_ANDROID_CERT_SHA256 ?? OFFICIAL_APP_CERT).split(',').map(s => s.trim()).filter(Boolean),
};

/**
 * The instance key wraps every user's data key. UNRESUB_SECRET_KEY wins; otherwise it is
 * read from (or generated into) <DATA_DIR>/secret.key, so a fresh install needs no setup.
 */
export const loadInstanceKey = (dir = env.dataDir, fromEnv = process.env.UNRESUB_SECRET_KEY) => {
  const parse = (b64: string, where: string) => {
    const key = Buffer.from(b64.trim(), 'base64');
    if (key.length !== 32) throw new Error(`${where} must be 32 bytes, base64-encoded`);
    return key;
  };
  if (fromEnv) return parse(fromEnv, 'UNRESUB_SECRET_KEY');
  const file = join(dir, 'secret.key');
  if (existsSync(file)) return parse(readFileSync(file, 'utf8'), file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Generated a new instance key at ${file}. Back it up with the data: without it bank tokens can't be decrypted.`);
  return parse(readFileSync(file, 'utf8'), file);
};
