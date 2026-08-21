import 'dotenv/config';
/**
 * One-command Schwab re-authorization.
 *
 *   npm run schwab-auth --workspace=backend
 *
 * Replaces the copy-the-entire-URL-out-of-the-address-bar flow. Opens the
 * browser, catches Schwab's redirect on a throwaway local HTTPS listener, and
 * exchanges the code automatically.
 *
 * Schwab requires an HTTPS redirect URI, so the listener needs a certificate.
 * A self-signed one is generated per run into a temp dir — the browser will warn
 * once, which is expected for 127.0.0.1 and is why the manual paste path is kept
 * as a fallback rather than removed.
 *
 * Port note: a redirect URI of https://127.0.0.1 implies port 443, which macOS
 * will not let a normal user bind. Register https://127.0.0.1:8182 on your
 * Schwab app and set SCHWAB_REDIRECT_URI to match for the automatic path; the
 * script falls back to paste when it cannot bind.
 */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { schwabFor } from '../services/brokers/index.js';

const REDIRECT = process.env['SCHWAB_REDIRECT_URI'] ?? 'https://127.0.0.1';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

/** Best-effort browser launch; silence failures since the URL is printed too. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .unref();
  } catch { /* printed below regardless */ }
}

function selfSignedCert(): { key: string; cert: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schwab-oauth-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf-8'), cert: fs.readFileSync(cert, 'utf-8') };
  } catch {
    return null;
  }
}

/** Resolves with the `code` query param, or null if the listener cannot run. */
function catchRedirect(port: number, timeoutMs = 180_000): Promise<string | null> {
  const tls = selfSignedCert();
  if (!tls) return Promise.resolve(null);

  return new Promise(resolve => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(v);
    };

    const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const code = new URL(req.url ?? '/', REDIRECT).searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:system-ui;background:#0a0e27;color:#f5c842;
         display:flex;align-items:center;justify-content:center;height:100vh">
         <h2>${code ? 'Schwab connected — you can close this tab.' : 'No authorization code received.'}</h2>
         </body></html>`,
      );
      finish(code);
    });

    server.on('error', () => finish(null));
    server.listen(port, '127.0.0.1');
    setTimeout(() => finish(null), timeoutMs).unref();
  });
}

async function main() {
  if (!process.env['SCHWAB_CLIENT_ID'] || !process.env['SCHWAB_CLIENT_SECRET']) {
    console.error('❌ SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET missing from backend/.env');
    process.exit(1);
  }

  const conn = schwabFor();

  const before = await conn.status();
  if (before.connected && !process.argv.includes('--force')) {
    const days = ((before.refreshExpiresAt ?? 0) - Date.now()) / 86_400_000;
    console.log(`✅ Schwab already connected. Refresh grant valid for ${days.toFixed(1)} more days.`);
    console.log('   Re-run with --force to reconnect anyway.');
    return;
  }

  // `state` is echoed back by Schwab; verifying it rejects a redirect we did not initiate.
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = conn.authorizeUrl(state);

  const port = Number(new URL(REDIRECT).port || 443);
  console.log(`\nOpening Schwab authorization in your browser…`);
  console.log(`If it does not open, visit:\n  ${url}\n`);

  const listener = catchRedirect(port);
  openBrowser(url);

  console.log(`Waiting for the redirect on ${REDIRECT} …`);
  console.log('(Your browser will warn about the self-signed certificate — that is expected;');
  console.log(" choose 'Advanced' → 'Proceed'.)\n");

  let code = await listener;

  if (!code) {
    console.log(`Could not capture the redirect automatically on port ${port}.`);
    console.log('Paste the full URL from your address bar instead (it starts with');
    console.log(`${REDIRECT} and may show a connection error — that is fine).\n`);
    const pasted = (await ask('URL or code: ')).trim();
    try {
      code = new URL(pasted).searchParams.get('code') ?? pasted;
    } catch {
      code = pasted;
    }
  }

  if (!code) {
    console.error('❌ No authorization code obtained.');
    process.exit(1);
  }

  console.log('\nExchanging code for tokens…');
  await conn.completeAuthorization(decodeURIComponent(code));

  const after = await conn.status();
  const days = ((after.refreshExpiresAt ?? 0) - Date.now()) / 86_400_000;
  console.log(`✅ Connected. Refresh grant valid for ${days.toFixed(1)} days.`);
  console.log('   Schwab refresh grants expire after 7 days and cannot be renewed');
  console.log('   automatically — re-run this when the app reports a disconnection.');
}

main().catch(err => {
  console.error('❌', err?.message ?? err);
  process.exit(1);
});
