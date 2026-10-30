import {
  createHash,
  createSecretKey,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';

export class UnknownKeyError extends Error {
  constructor(kid: string) {
    super(`unknown key id: ${kid}`);
    this.name = 'UnknownKeyError';
  }
}

export interface KeyRingEntry {
  kid: string;
  key: KeyObject;
}

// Holds the symmetric keys available for envelope encryption. The ring
// carries multiple key ids so a future rotation can add a new default while
// still decrypting records sealed under older ids.
export class KeyRing {
  private readonly keys = new Map<string, KeyObject>();
  readonly defaultKid: string;

  constructor(entries: KeyRingEntry[], defaultKid: string) {
    for (const entry of entries) {
      if (entry.key.symmetricKeySize !== 32) {
        throw new Error(`key for ${entry.kid} must be 32 bytes (AES-256)`);
      }
      this.keys.set(entry.kid, entry.key);
    }
    if (!this.keys.has(defaultKid)) {
      throw new Error(`default kid not in ring: ${defaultKid}`);
    }
    this.defaultKid = defaultKid;
  }

  get(kid: string): KeyObject {
    const key = this.keys.get(kid);
    if (!key) throw new UnknownKeyError(kid);
    return key;
  }

  getDefault(): KeyObject {
    return this.get(this.defaultKid);
  }

  kids(): string[] {
    return [...this.keys.keys()];
  }
}

// Derive a 32-byte AES key from the master key. The master key is a
// high-entropy random secret, so SHA-256 is an appropriate KDF here.
// NOTE: byte-for-byte compatibility with already-sealed ciphertexts is
// mandatory — do not change this derivation.
export function deriveKey(masterKey: string): KeyObject {
  const digest = createHash('sha256').update(masterKey, 'utf8').digest();
  return createSecretKey(digest);
}

// Session tokens must not be signed with the data-encryption key. Derive an
// independent HKDF subkey instead; rotating one no longer implicates the
// other. Existing cookies break once (acceptable: sessions are 12h and
// users can log in again); sealed data stays decryptable.
export function deriveSessionKey(masterKey: string): string {
  const derived = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.alloc(0),
    Buffer.from('sess'),
    32,
  );
  return Buffer.from(derived).toString('hex');
}

// v1 ring: a single kid "k1" derived from HUB_MASTER_KEY. Rotation later
// adds entries while keeping k1 for existing records.
export const V1_DEFAULT_KID = 'k1';

export function buildKeyRing(masterKey: string): KeyRing {
  return new KeyRing(
    [{ kid: V1_DEFAULT_KID, key: deriveKey(masterKey) }],
    V1_DEFAULT_KID,
  );
}
