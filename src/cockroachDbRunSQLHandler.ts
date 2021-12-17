import { SecretsManager } from 'aws-sdk';
import { Client, ClientConfig } from 'pg';
import { CockroachDBUserSecret } from './lib/types';

interface RunSqlEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: RunSqlEventProperties;
}

interface RunSqlEventProperties {
  database: string;
  rootUserSecretId: string;
  upQuery: string;
  downQuery: string;
}

const secrets = new SecretsManager();

export async function handler(event: RunSqlEvent) {
  console.log("Getting root secret")
  const rootSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.rootUserSecretId
  }).promise();

  const rootSecret: CockroachDBUserSecret = JSON.parse(rootSecretResponse.SecretString!);

  const client = new Client({
    host: rootSecret.endpoint,
    port: 26257,
    password: rootSecret.password,
    user: rootSecret.username,
    database: event.ResourceProperties.database,
    options: rootSecret.options,
    ssl: {
      rejectUnauthorized: false
    }
  } as ClientConfig)

  console.log("Connecting")
  await client.connect();

  switch (event.RequestType) {
    case 'Create':
      console.log(await client.query(event.ResourceProperties.upQuery));
      break;
    case 'Delete':
      console.log(await client.query(event.ResourceProperties.downQuery));
      break;
  }
  await client.end();
}
