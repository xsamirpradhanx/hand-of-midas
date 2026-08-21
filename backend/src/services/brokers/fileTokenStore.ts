/**
 * Filesystem credential storage for local development.
 *
 * Preserves the existing `.schwab_token.json` workflow — `npm run schwab-auth`
 * writes that file and the dev server reads it — so switching to the store
 * abstraction does not force every developer to stand up DynamoDB and KMS.
 *
 * Single-principal by construction: a developer machine has one Schwab login.
 * Writes for a non-SYSTEM principal are rejected rather than silently sharing
 * one file between principals, which would reproduce exactly the cross-user
 * bleed this refactor exists to remove.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SYSTEM_PRINCIPAL,
  type BrokerId,
  type BrokerTokenStore,
  type NewBrokerToken,
  type StoredBrokerToken,
} from './types.js';

/** Legacy on-disk shape written by scripts/schwab-auth-setup.ts. */
interface LegacyTokenFile {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
  timestamp?: number;
  revokedAt?: number;
  version?: number;
}

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Schwab refresh grants live 7 days and cannot be renewed programmatically. */
const REFRESH_GRANT_MS = 7 * 24 * 60 * 60 * 1000;

function candidates(broker: BrokerId): string[] {
  const filename = broker === 'schwab' ? '.schwab_token.json' : `.${broker}_token.json`;
  return [
    process.env['SCHWAB_TOKEN_PATH'],
    path.join(process.cwd(), filename),
    path.join(MODULE_ROOT, filename),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function resolvePath(broker: BrokerId): string {
  const list = candidates(broker);
  return list.find(p => fs.existsSync(p)) ?? list[list.length - 1]!;
}

export class FileBrokerTokenStore implements BrokerTokenStore {
  private assertLocalPrincipal(principal: string): void {
    if (principal !== SYSTEM_PRINCIPAL) {
      throw new Error(
        `FileBrokerTokenStore only serves the ${SYSTEM_PRINCIPAL} principal (got "${principal}"). ` +
          'Per-user credentials require the DynamoDB store.',
      );
    }
  }

  async load(principal: string, broker: BrokerId): Promise<StoredBrokerToken | null> {
    if (principal !== SYSTEM_PRINCIPAL) return null;
    const file = resolvePath(broker);
    if (!fs.existsSync(file)) return null;

    let raw: LegacyTokenFile;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
    if (!raw.access_token && !raw.refresh_token) return null;

    const issued = raw.timestamp ?? 0;
    return {
      broker,
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      accessExpiresAt: issued + (raw.expires_in ?? 1800) * 1000,
      // `+` binds tighter than `||`, so the previous
      //   issued + (x ?? 0) * 1000 || issued + REFRESH_GRANT_MS
      // always took the left branch: `issued + 0` is a large truthy epoch, so the
      // fallback was unreachable and refreshExpiresAt collapsed to the ISSUE time.
      // Every healthy token then read as an expired grant. Schwab omits
      // refresh_token_expires_in entirely, so this was the normal path, not an edge.
      refreshExpiresAt:
        typeof raw.refresh_token_expires_in === 'number' && raw.refresh_token_expires_in > 0
          ? issued + raw.refresh_token_expires_in * 1000
          : issued + REFRESH_GRANT_MS,
      scope: raw.scope,
      revokedAt: raw.revokedAt,
      version: raw.version ?? 1,
    };
  }

  async save(
    principal: string,
    broker: BrokerId,
    token: NewBrokerToken,
    expectedVersion?: number,
  ): Promise<StoredBrokerToken> {
    this.assertLocalPrincipal(principal);
    const file = resolvePath(broker);
    const version = (expectedVersion ?? 0) + 1;
    const payload: LegacyTokenFile = {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_in: Math.max(0, Math.round((token.accessExpiresAt - Date.now()) / 1000)),
      refresh_token_expires_in: Math.max(0, Math.round((token.refreshExpiresAt - Date.now()) / 1000)),
      scope: token.scope,
      timestamp: Date.now(),
      version,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    return { ...token, version };
  }

  async markRevoked(principal: string, broker: BrokerId): Promise<void> {
    if (principal !== SYSTEM_PRINCIPAL) return;
    const file = resolvePath(broker);
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      raw.revokedAt = Date.now();
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');
    } catch {
      /* a corrupt token file is already unusable */
    }
  }

  async clear(principal: string, broker: BrokerId): Promise<void> {
    if (principal !== SYSTEM_PRINCIPAL) return;
    const file = resolvePath(broker);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
