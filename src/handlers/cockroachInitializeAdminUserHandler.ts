import { AutoScaling, EC2, ECS, SecretsManager, SSM } from 'aws-sdk';
import { CockroachDBUserSecret, TaskStateChangeEvent } from '../lib/types';
import { Client } from 'pg';
import { promisify } from 'util';
import { retryWithBackoff } from '../lib/lib';
const timeoutAsync = promisify((ms: number, cb: (err: any) => void) => setTimeout(cb, ms))

interface InitAdminUserEvent {
  RequestType: 'Create' | 'Update' | 'Delete',
  ResourceProperties: InitAdminUserProperties
}

interface InitAdminUserProperties {
  userSecretId: string;
}

const caCrtParam = process.env.COCKROACH_CA_CRT_PARAM || "";
const rootCrtParam = process.env.COCKROACH_ROOT_CRT_PARAM || "";
const rootKeyParam = process.env.COCKROACH_ROOT_KEY_PARAM || "";

const SSMClient = new SSM();
const SecretClient = new SecretsManager()

export async function handler(event: InitAdminUserEvent) {
  if (event.RequestType !== 'Create') {
    return;
  }

  const [{Parameter: caCrtValue}, {Parameter: rootCrtValue}, {Parameter: rootKeyValue}] = await Promise.all([
    SSMClient.getParameter({Name: caCrtParam, WithDecryption: true}).promise(),
    SSMClient.getParameter({Name: rootCrtParam, WithDecryption: true}).promise(),
    SSMClient.getParameter({Name: rootKeyParam, WithDecryption: true}).promise(),
  ])

  const userSecretResponse = await SecretClient.getSecretValue({
    SecretId: event.ResourceProperties.userSecretId,
  }).promise();

  const userSecret: CockroachDBUserSecret = JSON.parse(userSecretResponse.SecretString!);

  const client = new Client({
    ssl: {
      rejectUnauthorized: false,
      ca: Buffer.from(caCrtValue!.Value!),
      key: Buffer.from(rootKeyValue!.Value!),
      cert: Buffer.from(rootCrtValue!.Value!)
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

