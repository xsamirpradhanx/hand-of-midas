import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBrokerTokenStore } from './fileTokenStore.js';
import { SYSTEM_PRINCIPAL } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brokerstore-'));
  process.env['SCHWAB_TOKEN_PATH'] = path.join(tmp, '.schwab_token.json');
});
afterEach(() => {
  delete process.env['SCHWAB_TOKEN_PATH'];
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(payload: Record<string, unknown>) {
  fs.writeFileSync(process.env['SCHWAB_TOKEN_PATH']!, JSON.stringify(payload), 'utf-8');
}

describe('FileBrokerTokenStore', () => {
  it('treats a token without refresh_token_expires_in as having a 7-day grant', async () => {
    // Schwab omits this field, so it is the normal shape rather than an edge case.
    const issued = Date.now() - 60_000;
    write({ access_token: 'a', refresh_token: 'r', expires_in: 1800, timestamp: issued });

    const t = await new FileBrokerTokenStore().load(SYSTEM_PRINCIPAL, 'schwab');
    expect(t).not.toBeNull();
    // Must be in the FUTURE. Collapsing to the issue time made every healthy
    // token report as an expired grant.
    expect(t!.refreshExpiresAt).toBeGreaterThan(Date.now());
    expect(t!.refreshExpiresAt).toBeCloseTo(issued + 7 * DAY, -4);
  });

  it('honours an explicit refresh_token_expires_in when present', async () => {
    const issued = Date.now();
    write({
      access_token: 'a', refresh_token: 'r', expires_in: 1800,
      refresh_token_expires_in: 3 * 24 * 60 * 60, timestamp: issued,
    });
    const t = await new FileBrokerTokenStore().load(SYSTEM_PRINCIPAL, 'schwab');
    expect(t!.refreshExpiresAt).toBeCloseTo(issued + 3 * DAY, -4);
  });

  it('refuses to serve or store a non-SYSTEM principal', async () => {
    write({ access_token: 'a', refresh_token: 'r', expires_in: 1800, timestamp: Date.now() });
    const store = new FileBrokerTokenStore();
    expect(await store.load('alice', 'schwab')).toBeNull();
    await expect(
      store.save('alice', 'schwab', {
        broker: 'schwab', accessToken: 'x', refreshToken: 'y',
        accessExpiresAt: Date.now() + 1000, refreshExpiresAt: Date.now() + DAY,
      }),
    ).rejects.toThrow(/only serves the SYSTEM principal/);
  });
});
