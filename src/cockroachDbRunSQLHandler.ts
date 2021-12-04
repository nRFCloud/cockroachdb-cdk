import { SecretsManager } from 'aws-sdk';
import { CockroachDBUserSecret } from './cockroachDBEKSCluster';
import {Client} from 'pg';

interface UserCreateEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: UserCreateEventProperties;
}

interface UserCreateEventProperties {
  database: string;
  rootUserSecretId: string;
  upQuery: string;
  downQuery: string;
}

const secrets = new SecretsManager();

export async function handler(event: UserCreateEvent) {
  console.log("Getting root secret")
  const rootSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.rootUserSecretId
  }).promise();

  const rootSecret: CockroachDBUserSecret = JSON.parse(rootSecretResponse.SecretString);

  const client = new Client({
    host: rootSecret.endpoint,
    port: 26257,
    password: rootSecret.password,
    user: rootSecret.username,
    database: event.ResourceProperties.database,
    ssl: {
      rejectUnauthorized: false
    }
  })

  await client.connect();

  switch (event.RequestType) {
    case 'Create':
      await client.query(event.ResourceProperties.upQuery);
      break;
    case 'Update':
      await client.query(event.ResourceProperties.downQuery);
      await client.query(event.ResourceProperties.upQuery);
      break;
    case 'Delete':
      await client.query(event.ResourceProperties.downQuery);
      break;
  }
  await client.end();
}
