// backend/src/util/encryption.js
//
// AES-256-GCM field-level encryption for PII and other sensitive data.
//
// Storage format (v1):
//   v{keyVersion}:{base64(salt)}:{base64(iv)}:{base64(authTag)}:{base64(ciphertext)}
//
// - The data-encryption key is derived per record with HKDF-SHA256 from the
//   versioned master key and a random per-record salt, so two identical
//   plaintexts never share a key or ciphertext.
// - Key versioning keeps old ciphertexts readable after rotation;
//   rotateField() re-encrypts a stored payload under the current key version.
// - Keys are configured via PII_ENCRYPTION_KEYS="v1=<hex64>,v2=<hex64>" (or the
//   single-key PII_ENCRYPTION_KEY=<hex64>, treated as v1) and
//   PII_ENCRYPTION_KEY_VERSION selects the active version (default: highest).
// - The key ring is loaded lazily so requiring this module never throws; a
//   clear error is raised only on first use without configuration.
//
// Legacy compatibility: decrypt()/decryptField() also understand the original
// {iv, content, tag} object format (and its JSON encoding) produced by the
// previous implementation, which encrypted directly under the raw master key.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce size for GCM
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = 'wavelum-pii-field';
const PAYLOAD_PATTERN = /^v(\d+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/;

class EncryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncryptionError';
  }
}

let auditHook = null;
let keyRingCache = null;

// Optional sink for audit events. Receives metadata only — never plaintext,
// ciphertext, keys, salts, or IVs.
function setAuditHook(fn) {
  auditHook = typeof fn === 'function' ? fn : null;
}

function audit(event) {
  try {
    // Lazy: the crypto path must stay usable even when logging deps are
    // unavailable; never let audit failure break encrypt/decrypt.
    require('../utils/logger').info('pii-encryption', event);
  } catch {
    /* audit must never break the crypto path */
  }
  if (auditHook) {
    try {
      auditHook(event);
    } catch {
      /* same */
    }
  }
}

function parseKeyRing() {
  const ring = new Map();
  const multi = process.env.PII_ENCRYPTION_KEYS;
  if (multi && multi.trim()) {
    for (const pair of multi.split(',')) {
      const [version, hex] = pair.split('=').map((s) => s && s.trim());
      if (!version || !hex) {
        throw new EncryptionError('PII_ENCRYPTION_KEYS entries must be "v<n>=<hex>"');
      }
      ring.set(version, decodeKey(version, hex));
    }
  } else if (process.env.PII_ENCRYPTION_KEY) {
    ring.set('v1', decodeKey('v1', process.env.PII_ENCRYPTION_KEY));
  }
  return ring;
}

function decodeKey(version, hex) {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionError(`PII key ${version} must be ${KEY_LENGTH} bytes of hex`);
  }
  return key;
}

function getKeyRing() {
  if (!keyRingCache) {
    keyRingCache = parseKeyRing();
  }
  if (keyRingCache.size === 0) {
    throw new EncryptionError(
      'PII encryption is not configured: set PII_ENCRYPTION_KEYS (or PII_ENCRYPTION_KEY)'
    );
  }
  return keyRingCache;
}

function getCurrentVersion(ring) {
  const configured = process.env.PII_ENCRYPTION_KEY_VERSION;
  if (configured) {
    if (!ring.has(configured)) {
      throw new EncryptionError(`PII_ENCRYPTION_KEY_VERSION ${configured} has no configured key`);
    }
    return configured;
  }
  return [...ring.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).pop();
}

function deriveKey(masterKey, salt) {
  return crypto.hkdfSync('sha256', masterKey, salt, Buffer.from(HKDF_INFO, 'utf8'), KEY_LENGTH);
}

function gcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key, iv, tag, ciphertext) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decodeSegment(name, segment) {
  try {
    return Buffer.from(segment, 'base64');
  } catch {
    throw new EncryptionError(`Malformed encrypted payload: bad ${name}`);
  }
}

/**
 * Encrypts a UTF-8 string field for at-rest storage.
 * @param {string} plaintext
 * @returns {string} versioned self-describing payload
 */
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const ring = getKeyRing();
  const version = getCurrentVersion(ring);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(ring.get(version), salt);
  const { iv, ciphertext, tag } = gcmEncrypt(key, String(plaintext));
  const payload =
    `${version}.${salt.toString('base64')}.${iv.toString('base64')}` +
    `.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
  audit({ op: 'encrypt', keyVersion: version });
  return payload;
}

function decryptVersioned(payload) {
  const match = PAYLOAD_PATTERN.exec(payload);
  if (!match) {
    throw new EncryptionError('Malformed encrypted payload');
  }
  const [, versionNum, saltB64, ivB64, tagB64, ctB64] = match;
  const version = `v${versionNum}`;
  const ring = getKeyRing();
  const masterKey = ring.get(version);
  if (!masterKey) {
    throw new EncryptionError(`No configured key for payload version ${version}`);
  }
  const key = deriveKey(
    masterKey,
    decodeSegment('salt', saltB64)
  );
  try {
    return {
      plaintext: gcmDecrypt(
        key,
        decodeSegment('iv', ivB64),
        decodeSegment('tag', tagB64),
        decodeSegment('ciphertext', ctB64)
      ),
      keyVersion: version,
    };
  } catch {
    throw new EncryptionError('Decryption failed: integrity check rejected the payload');
  }
}

function decryptLegacyObject(legacy) {
  // Original implementation: AES-256-GCM directly under the raw master key,
  // no HKDF, {iv, content, tag} hex object.
  const hex = process.env.PII_ENCRYPTION_KEY;
  if (!hex) {
    throw new EncryptionError('Legacy payload requires PII_ENCRYPTION_KEY');
  }
  const key = decodeKey('legacy', hex);
  try {
    return gcmDecrypt(
      key,
      Buffer.from(legacy.iv, 'hex'),
      Buffer.from(legacy.tag, 'hex'),
      Buffer.from(legacy.content, 'hex')
    );
  } catch {
    throw new EncryptionError('Decryption failed: integrity check rejected the payload');
  }
}

/**
 * Decrypts a payload produced by encryptField() (any key version) or by the
 * legacy {iv, content, tag} object format (object or JSON-string form).
 * Throws EncryptionError on malformed input or integrity-check failure.
 */
function decryptField(payload) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'object' && payload.iv && payload.content && payload.tag) {
    const plaintext = decryptLegacyObject(payload);
    audit({ op: 'decrypt', keyVersion: 'legacy' });
    return plaintext;
  }
  if (typeof payload !== 'string') {
    throw new EncryptionError('Unsupported encrypted payload type');
  }
  const trimmed = payload.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.iv && parsed.content && parsed.tag) {
        const plaintext = decryptLegacyObject(parsed);
        audit({ op: 'decrypt', keyVersion: 'legacy' });
        return plaintext;
      }
    } catch (err) {
      if (err instanceof EncryptionError) throw err;
      throw new EncryptionError('Malformed encrypted payload');
    }
  }
  const { plaintext, keyVersion } = decryptVersioned(trimmed);
  audit({ op: 'decrypt', keyVersion });
  return plaintext;
}

/**
 * Returns true when the value looks like a versioned payload from this module
 * (used by model getters to distinguish ciphertext from legacy plaintext).
 */
function isEncryptedField(value) {
  return typeof value === 'string' && PAYLOAD_PATTERN.test(value.trim());
}

/**
 * Re-encrypts a stored payload under the current key version.
 * Accepts versioned payloads and legacy objects. No-ops when already current.
 */
function rotateField(payload, options = {}) {
  if (payload === null || payload === undefined) return payload;
  const ring = getKeyRing();
  const current = getCurrentVersion(ring);
  if (typeof payload === 'string') {
    const match = PAYLOAD_PATTERN.exec(payload.trim());
    if (match && `v${match[1]}` === current && !options.force) {
      return payload;
    }
  }
  const plaintext = decryptField(payload);
  audit({ op: 'rotate', toKeyVersion: current });
  return encryptField(plaintext);
}

// Backward-compatible API for existing callers (e.g. middleware/prisma_pii).
// encrypt() now returns the compact versioned payload; decrypt() accepts both
// the new payload, legacy objects, and their JSON encoding.
function encrypt(text) {
  return encryptField(text);
}

function decrypt(encrypted) {
  return decryptField(encrypted);
}

/**
 * Builds a Sequelize attribute get/set pair that stores a JSON value as an
 * encrypted {$enc: '<versioned payload>'} object at rest and returns the
 * decrypted object on read. Legacy plaintext JSON stays readable; undecryptable
 * values are returned raw (and logged) rather than breaking hydration.
 * @param {string} fieldName attribute name, used only for error logging
 */
function encryptedJsonField(fieldName) {
  return {
    get() {
      const raw = this.getDataValue(fieldName);
      if (raw === null || raw === undefined) return raw;
      try {
        if (typeof raw === 'string' && isEncryptedField(raw)) {
          return JSON.parse(decryptField(raw));
        }
        if (typeof raw === 'object' && isEncryptedField(raw.$enc)) {
          return JSON.parse(decryptField(raw.$enc));
        }
      } catch (err) {
        audit({ op: 'decrypt', field: fieldName, error: 'failed' });
      }
      return raw;
    },
    set(value) {
      if (value === null || value === undefined) {
        this.setDataValue(fieldName, value);
        return;
      }
      this.setDataValue(fieldName, { $enc: encryptField(JSON.stringify(value)) });
    },
  };
}

// Test support: drop the cached key ring so tests can vary the environment.
function __resetKeyRingForTests() {
  keyRingCache = null;
}

module.exports = {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  rotateField,
  isEncryptedField,
  encryptedJsonField,
  setAuditHook,
  EncryptionError,
  __resetKeyRingForTests,
};
