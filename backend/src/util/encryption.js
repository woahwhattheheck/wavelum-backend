// backend/src/util/encryption.js
const crypto = require('crypto');
const logger = require('../utils/logger');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const DEFAULT_KEY_VERSION = '1';
const HKDF_INFO_PREFIX = 'wavelum:pii';

function decodeMasterKey(value, version) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== KEY_LENGTH) {
      throw new Error(`PII encryption key ${version} must be 32 bytes`);
    }
    return Buffer.from(value);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`PII encryption key ${version} is missing`);
  }

  const raw = value.trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === KEY_LENGTH) {
    return decoded;
  }

  throw new Error(`PII encryption key ${version} must be 64 hex characters or 32 bytes of base64`);
}

function getKeyring() {
  const configured = {};
  if (process.env.PII_ENCRYPTION_KEYS) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.PII_ENCRYPTION_KEYS);
    } catch (error) {
      throw new Error(`PII_ENCRYPTION_KEYS must be valid JSON: ${error.message}`);
    }

    const entries = parsed && parsed.keys && typeof parsed.keys === 'object'
      ? parsed.keys
      : parsed;

    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('PII_ENCRYPTION_KEYS must be an object mapping versions to keys');
    }

    for (const [version, key] of Object.entries(entries)) {
      configured[String(version)] = decodeMasterKey(key, version);
    }
  }

  const versions = Object.keys(configured).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const activeVersion = String(
    process.env.PII_ENCRYPTION_KEY_VERSION ||
    versions[versions.length - 1] ||
    DEFAULT_KEY_VERSION
  );

  // Backwards-compatible single-key configuration. During rotation,
  // PII_ENCRYPTION_KEYS should contain both old and new versions.
  if (process.env.PII_ENCRYPTION_KEY) {
    configured[activeVersion] = decodeMasterKey(
      process.env.PII_ENCRYPTION_KEY,
      activeVersion
    );
  }

  if (!configured[activeVersion]) {
    throw new Error(
      `No PII encryption key configured for active version ${activeVersion}`
    );
  }

  return { activeVersion, keys: configured };
}

function deriveRecordKey(masterKey, salt, version) {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      masterKey,
      salt,
      Buffer.from(`${HKDF_INFO_PREFIX}:${version}`, 'utf8'),
      KEY_LENGTH
    )
  );
}

function audit(event, version) {
  if (process.env.PII_ENCRYPTION_AUDIT_LOG === 'false') return;
  logger.info('PII encryption operation', {
    event,
    keyVersion: String(version),
  });
}

function encodePart(value) {
  return value.toString('base64');
}

function decodePart(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid encrypted payload: missing ${name}`);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) {
    throw new Error(`Invalid encrypted payload: malformed ${name}`);
  }
  return decoded;
}

function parseEnvelope(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Encrypted payload must be a versioned string');
  }

  const separator = value.indexOf(':');
  if (separator <= 0) {
    throw new Error('Invalid encrypted payload: missing key version');
  }

  const version = value.slice(0, separator);
  const parts = value.slice(separator + 1).split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted payload: expected salt.iv.tag.ciphertext');
  }

  const [salt, iv, tag, ciphertext] = parts.map((part, index) =>
    decodePart(part, ['salt', 'iv', 'auth tag', 'ciphertext'][index])
  );

  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || tag.length !== 16) {
    throw new Error('Invalid encrypted payload: invalid cryptographic component length');
  }

  return { version, salt, iv, tag, ciphertext };
}

function isEncryptedValue(value) {
  if (value && typeof value === 'object') {
    return Boolean(value.iv && value.content && value.tag);
  }

  if (typeof value !== 'string') return false;

  try {
    parseEnvelope(value);
    return true;
  } catch (_) {
    return false;
  }
}

function encrypt(text, options = {}) {
  if (text === null || text === undefined) return text;

  const plaintext = Buffer.from(String(text), 'utf8');
  const { activeVersion, keys } = getKeyring();
  const version = String(options.version || activeVersion);
  const masterKey = keys[version];

  if (!masterKey) {
    throw new Error(`No PII encryption key configured for version ${version}`);
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveRecordKey(masterKey, salt, version);
  const aad = Buffer.from(`${HKDF_INFO_PREFIX}:${version}`, 'utf8');

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = `${version}:${[
    salt,
    iv,
    tag,
    ciphertext,
  ].map(encodePart).join('.')}`;

  audit('encrypt', version);
  return envelope;
}

function decryptLegacyObject(encrypted) {
  const { activeVersion, keys } = getKeyring();
  const masterKey = keys[activeVersion];
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  const ciphertext = Buffer.from(encrypted.content, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  audit('decrypt-legacy', activeVersion);
  return plaintext;
}

function decrypt(encrypted) {
  if (encrypted === null || encrypted === undefined) return encrypted;

  if (encrypted && typeof encrypted === 'object') {
    if (!encrypted.iv || !encrypted.content || !encrypted.tag) {
      throw new Error('Invalid legacy encrypted payload');
    }
    return decryptLegacyObject(encrypted);
  }

  const { version, salt, iv, tag, ciphertext } = parseEnvelope(encrypted);
  const { keys } = getKeyring();
  const masterKey = keys[version];

  if (!masterKey) {
    throw new Error(`No PII encryption key configured for version ${version}`);
  }

  const key = deriveRecordKey(masterKey, salt, version);
  const aad = Buffer.from(`${HKDF_INFO_PREFIX}:${version}`, 'utf8');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  audit('decrypt', version);
  return plaintext;
}

function encryptField(value) {
  if (value === null || value === undefined || value === '') return value;
  return encrypt(value);
}

function decryptField(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncryptedValue(value)) return value;
  return decrypt(value);
}

function getEnvelopeVersion(value) {
  if (typeof value !== 'string') return null;
  try {
    return parseEnvelope(value).version;
  } catch (_) {
    return null;
  }
}

function rotateEncryptedValue(value, targetVersion) {
  if (!isEncryptedValue(value)) {
    throw new Error('Cannot rotate a value that is not encrypted');
  }

  const plaintext = decrypt(value);
  const { activeVersion } = getKeyring();
  const version = String(targetVersion || activeVersion);
  const rotated = encrypt(plaintext, { version });
  audit('rotate', version);
  return rotated;
}

module.exports = {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  rotateEncryptedValue,
  getEnvelopeVersion,
  isEncryptedValue,
};
