/**
 * Envelope encryption for stored broker credentials.
 *
 * A refresh token is a bearer credential for someone's brokerage account.
 * DynamoDB's encryption at rest is table-level and transparent to anyone who
 * can read the table, so it does not protect the credential from an overly
 * broad IAM grant, a console reader, or a table export. These fields are
 * encrypted before they are written.
 *
 * KMS is used directly (Encrypt/Decrypt) rather than generating data keys:
 * tokens are a few hundred bytes, far inside the 4 KB limit for direct KMS
 * encryption, and per-item data keys would add a second round trip for no gain
 * at this size.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

export interface Cipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const KEY_ID = process.env['BROKER_TOKEN_KMS_KEY_ID'];

/**
 * True when running inside Lambda. AWS sets these in every managed runtime;
 * neither is present on a developer machine.
 */
export function isDeployed(): boolean {
  return Boolean(process.env['AWS_LAMBDA_FUNCTION_NAME'] || process.env['LAMBDA_TASK_ROOT']);
}

class KmsCipher implements Cipher {
  private client = new KMSClient({});

  constructor(private readonly keyId: string) {}

  async encrypt(plaintext: string): Promise<string> {
    const res = await this.client.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(plaintext, 'utf-8') }),
    );
    if (!res.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return Buffer.from(res.CiphertextBlob).toString('base64');
  }

  async decrypt(ciphertext: string): Promise<string> {
    const res = await this.client.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, 'base64') }),
    );
    if (!res.Plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(res.Plaintext).toString('utf-8');
  }
}

/**
 * Local-development passthrough.
 *
 * Constructing this in a deployed environment throws rather than degrading to
 * plaintext. A misconfigured key should fail the deploy loudly — silently
 * writing unencrypted refresh tokens to a shared table is the exact outcome
 * this module exists to prevent.
 */
class PlaintextCipher implements Cipher {
  constructor() {
    if (isDeployed()) {
      throw new Error(
        'BROKER_TOKEN_KMS_KEY_ID is required in a deployed environment. ' +
          'Refusing to store broker refresh tokens unencrypted.',
      );
    }
  }
  async encrypt(plaintext: string): Promise<string> {
    return plaintext;
  }
  async decrypt(ciphertext: string): Promise<string> {
    return ciphertext;
  }
}

let cached: Cipher | undefined;

export function getCipher(): Cipher {
  if (!cached) cached = KEY_ID ? new KmsCipher(KEY_ID) : new PlaintextCipher();
  return cached;
}

/** Test seam — lets a suite install a fake without reaching into module state. */
export function setCipherForTesting(cipher: Cipher | undefined): void {
  cached = cipher;
}
