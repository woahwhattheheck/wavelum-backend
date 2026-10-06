const {
  encrypt,
  decrypt,
  encryptField,
  decryptField,
  rotateEncryptedValue,
  getEnvelopeVersion,
} = require('../src/util/encryption');

describe('PII Encryption', () => {
  const versionOneKey = '11'.repeat(32);
  const versionTwoKey = '22'.repeat(32);

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
      1: versionOneKey,
      2: versionTwoKey,
    });
    process.env.PII_ENCRYPTION_KEY_VERSION = '2';
    process.env.PII_ENCRYPTION_AUDIT_LOG = 'false';
    delete process.env.PII_ENCRYPTION_KEY;
  });

  afterAll(() => {
    delete process.env.PII_ENCRYPTION_KEYS;
    delete process.env.PII_ENCRYPTION_KEY_VERSION;
    delete process.env.PII_ENCRYPTION_AUDIT_LOG;
  });

  it('encrypts with AES-256-GCM and decrypts the versioned envelope', () => {
    const original = 'John Doe';
    const encrypted = encrypt(original);

    expect(getEnvelopeVersion(encrypted)).toBe('2');
    expect(encrypted).not.toContain(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it('rejects ciphertext or authentication-tag tampering', () => {
    const encrypted = encrypt('sensitive');
    const last = encrypted.slice(-1);
    const tampered = encrypted.slice(0, -1) + (last === 'A' ? 'B' : 'A');

    expect(() => decrypt(tampered)).toThrow();
  });

  it('rotates an older record to the active key version', () => {
    process.env.PII_ENCRYPTION_KEY_VERSION = '1';
    const oldEnvelope = encrypt('rotate me');
    expect(getEnvelopeVersion(oldEnvelope)).toBe('1');

    process.env.PII_ENCRYPTION_KEY_VERSION = '2';
    const rotated = rotateEncryptedValue(oldEnvelope);

    expect(getEnvelopeVersion(rotated)).toBe('2');
    expect(decrypt(rotated)).toBe('rotate me');
  });

  it('keeps field wrappers backward compatible with existing plaintext', () => {
    const encrypted = encryptField('private note');

    expect(decryptField(encrypted)).toBe('private note');
    expect(decryptField('legacy plaintext')).toBe('legacy plaintext');
    expect(encryptField(null)).toBeNull();
  });
});
