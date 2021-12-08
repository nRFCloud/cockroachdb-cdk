import {SecretsManager} from 'aws-sdk'
import type { CockroachDBUserSecret, CockroachDBRootCertificateSecret } from './cockroachDBEKSCluster'
import {Client} from 'pg'

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

  await client.connect();

  await client.query(`create user if not exists "${userSecret.username}" with password $1;`, [userSecret.password])
  await client.query(`grant admin to "${userSecret.username}";`)

  await client.end();
}
