/** A software passkey for tests: makes WebAuthn registration and assertion responses like a real authenticator. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const head = (major: number, n: number) =>
  n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n])
  : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);

/** Just enough CBOR for attestation objects and COSE keys. */
const cbor = (v: unknown): Buffer => {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
};

const b64u = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class SoftPasskey {
  readonly id = randomBytes(16);
  #key: KeyObject;
  #pub: { x: Buffer; y: Buffer };
  #count = 0;
  userHandle = '';

  constructor(private origin = 'http://localhost', private rpId = 'localhost') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.#pub = { x: Buffer.from(jwk.x!, 'base64url'), y: Buffer.from(jwk.y!, 'base64url') };
  }

  #clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  #authData(attested: boolean) {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0); // user present, verified, attested data
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.#count);
    const parts: Buffer[] = [sha(this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, this.#pub.x], [-3, this.#pub.y]]));
      parts.push(Buffer.alloc(16), len, this.id, cose);
    }
    return Buffer.concat(parts);
  }

  /** Answer to navigator.credentials.create(options). */
  create(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.#authData(true)]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  /** Answer to navigator.credentials.get(options). */
  get(options: { challenge: string }) {
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge);
    const authenticatorData = this.#authData(false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), this.#key);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: this.userHandle },
    };
  }
}
