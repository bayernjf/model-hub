import { createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildKeyRing,
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
