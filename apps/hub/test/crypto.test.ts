import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildKeyRing,
  deriveKey,
  deriveSessionKey,
  KeyRing,
  UnknownKeyError,
} from '../src/crypto/keyring.js';
import {
  decrypt,
  EnvelopeError,
  encrypt,
  isEnvelope,
} from '../src/crypto/envelope.js';
import { isMasked, maskSecret } from '../src/crypto/mask.js';

const MASTER = 'x'.repeat(40);

function randomKey() {
  return createSecretKey(randomBytes(32));
}

function flipBit(encoded: string, index: number): string {
  const buf = Buffer.from(encoded, 'base64url');
  buf[index] = (buf[index] ?? 0) ^ 1;
  return buf.toString('base64url');
}

describe('envelope encryption', () => {
  it('round-trips plaintext and follows the enc$v1 format', () => {
    const ring = buildKeyRing(MASTER);
    const secret = 'sk-abcdef-1234567890';

    const envelope = encrypt(secret, ring);

    expect(isEnvelope(envelope)).toBe(true);
    expect(envelope.startsWith('enc$v1$k1$')).toBe(true);
    expect(decrypt(envelope, ring)).toBe(secret);
  });

  it('seals repeated plaintext with distinct nonces', () => {
    const ring = buildKeyRing(MASTER);
    expect(encrypt('same', ring)).not.toBe(encrypt('same', ring));
  });

  it('fails to decrypt under a different master key', () => {
    const ring = buildKeyRing(MASTER);
    const other = buildKeyRing('y'.repeat(40));
    const envelope = encrypt('secret', ring);

    expect(() => decrypt(envelope, other)).toThrow();
  });

  it('fails authentication when the nonce is tampered', () => {
    const ring = buildKeyRing(MASTER);
    const parts = encrypt('secret', ring).split('$');

    const broken = parts.slice();
    broken[3] = flipBit(parts[3] ?? '', 0);

    expect(() => decrypt(broken.join('$'), ring)).toThrow();
  });

  it('fails authentication when the ciphertext or tag is tampered', () => {
    const ring = buildKeyRing(MASTER);
    const parts = encrypt('secret', ring).split('$');

    const broken = parts.slice();
    broken[4] = flipBit(parts[4] ?? '', 0);

    expect(() => decrypt(broken.join('$'), ring)).toThrow();
  });

  it('rejects malformed or wrong-version envelopes', () => {
    const ring = buildKeyRing(MASTER);

    expect(() => decrypt('not-an-envelope', ring)).toThrow(EnvelopeError);
    expect(() => decrypt('enc$v9$k1$aa$bb', ring)).toThrow(EnvelopeError);
  });

  it('throws UnknownKeyError for an unregistered kid', () => {
    const ring = buildKeyRing(MASTER);
    const envelope = encrypt('secret', ring).replace('$k1$', '$k9$');

    expect(() => decrypt(envelope, ring)).toThrow(UnknownKeyError);
  });

  it('opens a legacy record sealed under an older key in the ring', () => {
    const oldKey = randomKey();
    const newKey = randomKey();
    const ring = new KeyRing(
      [
        { kid: 'k1', key: oldKey },
        { kid: 'k2', key: newKey },
      ],
      'k2',
    );
    const oldRing = new KeyRing([{ kid: 'k1', key: oldKey }], 'k1');
    const legacy = encrypt('legacy', oldRing);

    expect(decrypt(legacy, ring)).toBe('legacy');
  });
});

describe('key derivation split (enc vs session)', () => {
  it('keeps the enc derivation byte-identical to legacy SHA-256', () => {
    // Existing ciphertexts are sealed under SHA-256(masterKey); this contract
    // must never change.
    const legacy = createHash('sha256').update(MASTER, 'utf8').digest();
    expect(deriveKey(MASTER).export()).toEqual(legacy);
    expect(deriveKey(MASTER).export().byteLength).toBe(32);
  });

  it('derives a deterministic 32-byte session subkey distinct from the enc key', () => {
    const sess1 = deriveSessionKey(MASTER);
    const sess2 = deriveSessionKey(MASTER);
    expect(sess1).toBe(sess2);
    expect(Buffer.from(sess1, 'hex').byteLength).toBe(32);
    expect(sess1).not.toBe(deriveKey(MASTER).export().toString('hex'));
    expect(deriveSessionKey('other-master-key-0123456789')).not.toBe(sess1);
  });

  it('verifies session tokens signed with the session subkey only', async () => {
    const { createSessionToken, verifySessionToken } = await import(
      '../src/auth/session.js'
    );
    const sessionKey = deriveSessionKey(MASTER);
    const token = createSessionToken(
      { username: 'owner', role: 'owner' },
      sessionKey,
    );

    expect(verifySessionToken(token, sessionKey)).not.toBeNull();
    // Old cookies signed with the raw master key are invalidated on purpose.
    const legacyToken = createSessionToken(
      { username: 'owner', role: 'owner' },
      MASTER,
    );
    expect(verifySessionToken(legacyToken, sessionKey)).toBeNull();
    expect(verifySessionToken(token, MASTER)).toBeNull();
  });
});

describe('secret masking', () => {
  it('keeps only the last four characters', () => {
    expect(maskSecret('sk-1234567890')).toBe('****7890');
  });

  it('fully masks short secrets', () => {
    expect(maskSecret('ab')).toBe('****');
  });

  it('detects masked values', () => {
    expect(isMasked('****7890')).toBe(true);
    expect(isMasked('sk-1234567890')).toBe(false);
  });
});
