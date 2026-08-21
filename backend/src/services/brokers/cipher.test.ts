import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

/** Fresh module per case — getCipher() memoises its choice. */
async function loadCipherModule() {
  vi.resetModules();
  return import('./cipher.js');
}

describe('broker credential cipher', () => {
  it('refuses to store credentials unencrypted when deployed', async () => {
    process.env['AWS_LAMBDA_FUNCTION_NAME'] = 'handofmidas-backend';
    delete process.env['BROKER_TOKEN_KMS_KEY_ID'];
    const { getCipher } = await loadCipherModule();
    // Failing loudly is the point: silently writing plaintext refresh tokens to
    // a shared table is the outcome this guard exists to prevent.
    expect(() => getCipher()).toThrow(/BROKER_TOKEN_KMS_KEY_ID is required/);
  });

  it('allows a passthrough locally so dev does not need KMS', async () => {
    delete process.env['AWS_LAMBDA_FUNCTION_NAME'];
    delete process.env['LAMBDA_TASK_ROOT'];
    delete process.env['BROKER_TOKEN_KMS_KEY_ID'];
    const { getCipher } = await loadCipherModule();
    const cipher = getCipher();
    expect(await cipher.decrypt(await cipher.encrypt('token'))).toBe('token');
  });
});
