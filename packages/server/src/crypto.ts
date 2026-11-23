import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds the secret to its row. */
export const encryptSecret = (plain: string, key: Buffer, aad: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
};

export const decryptSecret = (payload: string, key: Buffer, aad: string) => {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    .setAAD(Buffer.from(aad))
    .setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison (hashes first so lengths don't leak). */
export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

// --- Passwords: scrypt (OWASP: N=2^17, r=8, p=1). Stored as `scrypt$N$r$p$salt$hash`. ---
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const scryptAsync = (password: string, salt: Buffer, o: { N: number; r: number; p: number; keylen: number }) =>
  new Promise<Buffer>((res, rej) =>
    scrypt(password.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * o.N * o.r }, (e, k) => (e ? rej(e) : res(k))),
  );

export const hashPassword = async (password: string, o = SCRYPT) => {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, o);
  return ['scrypt', o.N, o.r, o.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
};

export const verifyPassword = async (password: string, stored: string) => {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
  return timingSafeEqual(got, expected);
};

/** Same cost as a real check, for unknown usernames, so timing doesn't reveal which accounts exist. */
let dummy: Promise<string> | null = null;
export const burnPasswordCheck = async (password: string) => {
  dummy ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummy);
};
