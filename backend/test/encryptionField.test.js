// backend/test/encryptionField.test.js
const crypto = require('crypto');
const {
  encryptField,
  decryptField,
  rotateField,
  isEncryptedField,
  encryptedJsonField,
  setAuditHook,
  encrypt,
  decrypt,
  EncryptionError,
  __resetKeyRingForTests,
} = require('../src/util/encryption');

const KEY_V1 = crypto.randomBytes(32).toString('hex');
const KEY_V2 = crypto.randomBytes(32).toString('hex');
const LEGACY_KEY = crypto.randomBytes(32).toString('hex');

const savedEnv = { ...process.env };

function configureEnv({ multi = true, version } = {}) {
  if (multi) {
    process.env.PII_ENCRYPTION_KEYS = `v1=${KEY_V1},v2=${KEY_V2}`;
  } else {
    delete process.env.PII_ENCRYPTION_KEYS;
  }
  process.env.PII_ENCRYPTION_KEY = LEGACY_KEY;
  if (version) {
    process.env.PII_ENCRYPTION_KEY_VERSION = version;
  } else {
    delete process.env.PII_ENCRYPTION_KEY_VERSION;
  }
  __resetKeyRingForTests();
}

beforeEach(() => {
  configureEnv();
});

afterAll(() => {
  process.env = savedEnv;
  setAuditHook(null);
});

describe('encryptField / decryptField', () => {
  it('round-trips plaintext', () => {
    const payload = encryptField('John Doe');
    expect(decryptField(payload)).toBe('John Doe');
  });

  it('emits the versioned storage format', () => {
    const payload = encryptField('secret');
    expect(payload).toMatch(/^v2\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(isEncryptedField(payload)).toBe(true);
    expect(isEncryptedField('secret')).toBe(false);
  });

  it('produces distinct ciphertexts for identical plaintexts (per-record salt+iv)', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('round-trips unicode and long strings', () => {
    const text = '身份验证 — ' + 'x'.repeat(4096);
    expect(decryptField(encryptField(text))).toBe(text);
  });

  it('passes null/undefined through unchanged', () => {
    expect(encryptField(null)).toBeNull();
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeUndefined();
  });

  it('rejects tampered ciphertext', () => {
    const payload = encryptField('integrity');
    const parts = payload.split('.');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 0xff;
    parts[4] = ct.toString('base64');
    expect(() => decryptField(parts.join('.'))).toThrow(EncryptionError);
  });

  it('rejects tampered auth tag', () => {
    const payload = encryptField('integrity');
    const parts = payload.split('.');
    const tag = Buffer.from(parts[3], 'base64');
    tag[0] ^= 0xff;
    parts[3] = tag.toString('base64');
    expect(() => decryptField(parts.join('.'))).toThrow(EncryptionError);
  });

  it('rejects truncated authentication tags even when their prefix is genuine', () => {
    const parts = encryptField('protected').split('.');
    const originalTag = Buffer.from(parts[3], 'base64');
    parts[3] = originalTag.subarray(0, 4).toString('base64');
    expect(() => decryptField(parts.join('.'))).toThrow(EncryptionError);
  });

  it('rejects a noncanonical versioned base64 segment', () => {
    const parts = encryptField('protected').split('.');
    parts[1] += '=';
    expect(() => decryptField(parts.join('.'))).toThrow(EncryptionError);
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptField('not-a-payload')).toThrow(EncryptionError);
    expect(() => decryptField('v9.')).toThrow(EncryptionError);
  });

  it('rejects a payload version with no configured key', () => {
    const payload = encryptField('secret').replace(/^v2\./, 'v9.');
    expect(() => decryptField(payload)).toThrow(/v9/);
  });

  it('fails closed when no keys are configured', () => {
    delete process.env.PII_ENCRYPTION_KEYS;
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyRingForTests();
    expect(() => encryptField('x')).toThrow(EncryptionError);
  });

  it('decrypts with the named version while encrypting under the newest', () => {
    const payload = encryptField('versioned'); // current = v2 (highest)
    expect(payload.startsWith('v2.')).toBe(true);
    configureEnv({ version: 'v1' });
    const v1Payload = encryptField('older');
    expect(v1Payload.startsWith('v1.')).toBe(true);
    expect(decryptField(v1Payload)).toBe('older');
    expect(decryptField(payload)).toBe('versioned');
  });
});

describe('rotateField', () => {
  it('re-encrypts a v1 payload under the current version', () => {
    configureEnv({ version: 'v1' });
    const oldPayload = encryptField('rotate me');
    expect(oldPayload.startsWith('v1.')).toBe(true);

    configureEnv(); // current = v2
    const rotated = rotateField(oldPayload);
    expect(rotated.startsWith('v2.')).toBe(true);
    expect(decryptField(rotated)).toBe('rotate me');
  });

  it('is a no-op when the payload already uses the current version', () => {
    const payload = encryptField('current');
    expect(rotateField(payload)).toBe(payload);
  });

  it('authenticates an already-current payload before skipping rotation', () => {
    const parts = encryptField('untampered').split('.');
    const tag = Buffer.from(parts[3], 'base64');
    tag[0] ^= 1;
    parts[3] = tag.toString('base64');
    expect(() => rotateField(parts.join('.'))).toThrow(EncryptionError);
  });

  it('upgrades a legacy object payload', () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(LEGACY_KEY, 'hex'), iv);
    const content = Buffer.concat([cipher.update('legacy pii', 'utf8'), cipher.final()]);
    const legacy = { iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex') };

    const rotated = rotateField(legacy);
    expect(isEncryptedField(rotated)).toBe(true);
    expect(decryptField(rotated)).toBe('legacy pii');
  });
});

describe('legacy compatibility', () => {
  it('decrypts the original {iv, content, tag} object format', () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(LEGACY_KEY, 'hex'), iv);
    const content = Buffer.concat([cipher.update('legacy pii', 'utf8'), cipher.final()]);
    const legacy = { iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    expect(decryptField(legacy)).toBe('legacy pii');
  });

  it('decrypts the JSON-string form of a legacy object', () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(LEGACY_KEY, 'hex'), iv);
    const content = Buffer.concat([cipher.update('json form', 'utf8'), cipher.final()]);
    const json = JSON.stringify({ iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
    expect(decryptField(json)).toBe('json form');
  });

  it('keeps encrypt()/decrypt() working for existing callers', () => {
    const payload = encrypt('compat');
    expect(decrypt(payload)).toBe('compat');
    expect(isEncryptedField(payload)).toBe(true);
  });
});

describe('audit hook', () => {
  it('emits metadata-only audit events', () => {
    const events = [];
    setAuditHook((e) => events.push(e));
    const payload = encryptField('audited');
    decryptField(payload);
    // No-op rotate on a current-version payload emits nothing (no crypto performed).
    rotateField(payload);
    expect(events.map((e) => e.op)).toEqual(['encrypt', 'decrypt']);
    // A real rotation (old -> current) does emit.
    process.env.PII_ENCRYPTION_KEY_VERSION = 'v1';
    __resetKeyRingForTests();
    const old = encryptField('rotate-src');
    delete process.env.PII_ENCRYPTION_KEY_VERSION;
    __resetKeyRingForTests();
    rotateField(old);
    expect(events.filter((e) => e.op === 'rotate')).toHaveLength(1);
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain('audited');
    }
    setAuditHook(null);
  });
});

describe('encryptedJsonField codec (used by KycStatus.sep12_response_data)', () => {
  function fakeRecord() {
    const data = {};
    return {
      getDataValue: (k) => data[k],
      setDataValue: (k, v) => { data[k] = v; },
      _data: data,
    };
  }

  it('stores the value encrypted and reads it decrypted', () => {
    const { get, set } = encryptedJsonField('f');
    const record = fakeRecord();
    const pii = { first_name: 'Jane', id_number: 'X123' };
    set.call(record, pii);
    expect(record._data.f).toHaveProperty('$enc');
    expect(isEncryptedField(record._data.f.$enc)).toBe(true);
    expect(get.call(record)).toEqual(pii);
  });

  it('returns legacy plaintext values unchanged', () => {
    const { get } = encryptedJsonField('f');
    const record = fakeRecord();
    record._data.f = { first_name: 'Plain' };
    expect(get.call(record)).toEqual({ first_name: 'Plain' });
  });

  it('decrypts bare-string payloads stored at top level', () => {
    const { get } = encryptedJsonField('f');
    const record = fakeRecord();
    record._data.f = encryptField(JSON.stringify({ n: 1 }));
    expect(get.call(record)).toEqual({ n: 1 });
  });

  it('returns undecryptable stored data raw instead of throwing', () => {
    const { get } = encryptedJsonField('f');
    const record = fakeRecord();
    record._data.f = { $enc: 'v9.broken.payload.here.x' };
    expect(get.call(record)).toEqual({ $enc: 'v9.broken.payload.here.x' });
  });

  it('passes null through on write and read', () => {
    const { get, set } = encryptedJsonField('f');
    const record = fakeRecord();
    set.call(record, null);
    expect(record._data.f).toBeNull();
    expect(get.call(record)).toBeNull();
  });
});
