import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { KeyRing } from './keyring.js';

// Envelope format: enc$v1$<kid>$<iv base64url>$<ciphertext+tag base64url>
const PREFIX = 'enc';
const VERSION = 'v1';
const IV_BYTES = 12; // AES-GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag appended to ciphertext

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

// Seal a UTF-8 plaintext with the ring's default key, using a fresh random
// nonce per record. The GCM auth tag is appended to the ciphertext.
export function encrypt(plaintext: string, ring: KeyRing): string {
  const kid = ring.defaultKid;
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', ring.getDefault(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([ciphertext, tag]);

  return [
    PREFIX,
    VERSION,
    kid,
    iv.toString('base64url'),
    payload.toString('base64url'),
  ].join('$');
}

interface ParsedEnvelope {
  kid: string;
  iv: Buffer;
  payload: Buffer;
}

function parseEnvelope(value: string): ParsedEnvelope {
  const parts = value.split('$');
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new EnvelopeError('malformed envelope');
  }
  const version = parts[1];
  const kid = parts[2];
  const ivEncoded = parts[3];
  const payloadEncoded = parts[4];
  if (version !== VERSION) {
    throw new EnvelopeError(`unsupported envelope version: ${version ?? ''}`);
  }
  if (!kid || !ivEncoded || !payloadEncoded) {
    throw new EnvelopeError('envelope missing fields');
  }

  const iv = Buffer.from(ivEncoded, 'base64url');
  const payload = Buffer.from(payloadEncoded, 'base64url');
  if (iv.length !== IV_BYTES) {
    throw new EnvelopeError('invalid nonce length');
  }
  if (payload.length < TAG_BYTES) {
    throw new EnvelopeError('ciphertext too short');
  }
  return { kid, iv, payload };
}

// Open an envelope, verifying the GCM tag. Throws on tampering or when the
// referenced kid is not present in the ring (fail closed).
export function decrypt(value: string, ring: KeyRing): string {
  const { kid, iv, payload } = parseEnvelope(value);
  const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', ring.get(kid), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(`${PREFIX}$${VERSION}$`);
}
