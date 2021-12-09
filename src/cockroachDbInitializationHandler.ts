import {SecretsManager} from 'aws-sdk'
import type { CockroachDBUserSecret, CockroachDBRootCertificateSecret } from './cockroachDBEKSCluster'
import {Client} from 'pg'
import { promisify } from 'util';
const timeoutAsync = promisify((ms: number, cb: () => null) => setTimeout(cb, ms))

interface DBInitEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: DBInitEventProperties;
}

interface DBInitEventProperties {
  userSecretId: string;
  rootCertsSecretId: string;
}

const secrets = new SecretsManager();

export async function handler(event: DBInitEvent) {
  // If this is getting deleted, then the cluster is going away anyway
  if (event.RequestType !== "Create") {
    return;
  }

  console.log("Getting user secret")
  const userSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.userSecretId,
  }).promise();

  const userSecret: CockroachDBUserSecret = JSON.parse(userSecretResponse.SecretString);

  const rootCertSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.rootCertsSecretId
  }).promise();

  const rootCerts: CockroachDBRootCertificateSecret = JSON.parse(rootCertSecretResponse.SecretString)
  console.log(`Starting user creation for ${userSecret.username}`)

  const client = new Client({
    ssl: {
      rejectUnauthorized: false,
      ca: Buffer.from(rootCerts.caCrt, "base64"),
      key: Buffer.from(rootCerts.rootKey, "base64"),
      cert: Buffer.from(rootCerts.rootCrt, 'base64')
    },
    user: "root",
    port: 26257,
    host: userSecret.endpoint,
  });

  await retryWithBackoff(() => client.connect())
  await client.query(`create user if not exists "${userSecret.username}";`)
  await client.query(`alter user "${userSecret.username}" with password $1;`, [userSecret.password])
  await client.query(`grant admin to "${userSecret.username}";`)
  await client.end();
}

async function retryWithBackoff<T>(func: (...args: any[]) => T, tries = 10): Promise<T> {
  let lastErr: Error;
  for (let i=0; i < tries; i++) {
    try {
      const result = await func();
      return result;
    } catch (err) {
      lastErr = err;
      const timeout = (2**tries) * 100
      console.error(`Error occurred, retrying in ${timeout}ms`)
      console.error(err);
      await timeoutAsync(timeout);
    }
  }
  throw lastErr;
}
