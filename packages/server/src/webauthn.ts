import type { Context } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { HTTPException } from 'hono/http-exception';
import type { PasskeyRow } from './core-db.ts';
import { randomToken } from './crypto.ts';

export interface WebAuthnConfig {
  /** Public https URL; its host is the relying-party id. Without it, the request's own host is used (local use). */
  publicUrl: string | null;
  /** SHA-256 fingerprints (AB:CD:..) of Android apps allowed to sign in via Credential Manager. */
  androidCertFingerprints: string[];
}

/** Credential Manager reports the app, not a web origin: `android:apk-key-hash:<base64url sha256 of the signing cert>`. */
export const androidOrigin = (fingerprint: string) =>
  `android:apk-key-hash:${Buffer.from(fingerprint.replace(/[^0-9a-f]/gi, ''), 'hex').toString('base64url')}`;

const requestOrigin = (c: Context) => {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}`;
};

/** In-memory ceremony state: one challenge per flow, single use, five minutes. */
class Flows<T> {
  #m = new Map<string, { data: T; challenge: string; exp: number }>();
  put(challenge: string, data: T) {
    const now = Date.now();
    for (const [k, v] of this.#m) if (v.exp < now) this.#m.delete(k);
    const id = randomToken(18);
    this.#m.set(id, { data, challenge, exp: now + 5 * 60_000 });
    return id;
  }
  take(id: unknown) {
    const f = typeof id === 'string' ? this.#m.get(id) : undefined;
    if (!f || f.exp < Date.now()) throw new HTTPException(400, { message: 'This passkey request expired. Try again.' });
    this.#m.delete(id as string);
    return f;
  }
}

export class WebAuthn {
  #reg = new Flows<{ userId: string; username: string; meta: Record<string, unknown> }>();
  #auth = new Flows<{ userId: string | null }>();

  constructor(private cfg: WebAuthnConfig) {}

  rpId(c: Context) {
    return new URL(this.cfg.publicUrl ?? requestOrigin(c)).hostname;
  }

  origins(c: Context) {
    return [this.cfg.publicUrl ? new URL(this.cfg.publicUrl).origin : requestOrigin(c), ...this.cfg.androidCertFingerprints.map(androidOrigin)];
  }

  /** Options for creating a passkey. `meta` rides along to verify (e.g. a setup or invite marker). */
  async registrationOptions(c: Context, user: { id: string; username: string }, existing: PasskeyRow[], meta: Record<string, unknown> = {}) {
    const options = await generateRegistrationOptions({
      rpName: 'UnReSub',
      rpID: this.rpId(c),
      userName: user.username,
      userDisplayName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map(p => ({ id: p.id, transports: parseTransports(p.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { flowId: this.#reg.put(options.challenge, { userId: user.id, username: user.username, meta }), options };
  }

  async verifyRegistration(c: Context, flowId: unknown, response: unknown) {
    const flow = this.#reg.take(flowId);
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origins(c),
      expectedRPID: this.rpId(c),
      requireUserVerification: true,
    }).catch(e => {
      throw new HTTPException(400, { message: `The passkey wasn't accepted: ${(e as Error).message}` });
    });
    if (!result.verified) throw new HTTPException(400, { message: "The passkey wasn't accepted. Try again." });
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    return {
      ...flow.data,
      passkey: {
        id: credential.id,
        public_key: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ? JSON.stringify(credential.transports) : null,
        device_type: credentialDeviceType,
        backed_up: credentialBackedUp ? 1 : 0,
      },
    };
  }

  /** Discoverable-credential sign-in: no username needed. `userId` limits it to one account (step-up checks). */
  async authenticationOptions(c: Context, userId: string | null = null, allow: PasskeyRow[] = []) {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(c),
      userVerification: 'required',
      allowCredentials: allow.map(p => ({ id: p.id, transports: parseTransports(p.transports) })),
    });
    return { flowId: this.#auth.put(options.challenge, { userId }), options };
  }

  async verifyAuthentication(c: Context, flowId: unknown, response: unknown, find: (id: string) => PasskeyRow | undefined) {
    const flow = this.#auth.take(flowId);
    const r = response as AuthenticationResponseJSON;
    const passkey = typeof r?.id === 'string' ? find(r.id) : undefined;
    if (!passkey || (flow.data.userId && passkey.user_id !== flow.data.userId)) {
      throw new HTTPException(401, { message: "This passkey isn't registered on this server." });
    }
    const result = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origins(c),
      expectedRPID: this.rpId(c),
      requireUserVerification: true,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.public_key, 'base64url'), counter: passkey.counter, transports: parseTransports(passkey.transports) },
    }).catch(() => ({ verified: false as const, authenticationInfo: null }));
    if (!result.verified) throw new HTTPException(401, { message: 'The passkey check failed. Try again.' });
    return { passkey, newCounter: result.authenticationInfo.newCounter };
  }
}

const parseTransports = (t: string | null) => (t ? (JSON.parse(t) as AuthenticatorTransportFuture[]) : undefined);
