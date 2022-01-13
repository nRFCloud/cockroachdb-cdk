import { SecretsManager } from 'aws-sdk';
import { Client, ClientConfig } from 'pg';
import { Construct } from '@aws-cdk/core';
import { CockroachDBUserSecret } from '../lib/types';

interface UserCreateEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: UserCreateEventProperties;
}

interface UserCreateEventProperties {
  userSecretId: string;
  database: string;
  rootUserSecretId: string;
}

const secrets = new SecretsManager();

export async function handler(event: UserCreateEvent) {
  console.log("Getting root secret")
  const rootSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.rootUserSecretId
  }).promise();

  const rootSecret: CockroachDBUserSecret = JSON.parse(rootSecretResponse.SecretString!);

  console.log("Getting new user secret")
  const userSecretResponse = await secrets.getSecretValue({
    SecretId: event.ResourceProperties.userSecretId
  }).promise()

  const userSecret: CockroachDBUserSecret = JSON.parse(userSecretResponse.SecretString!);

  const client = new Client({
    host: rootSecret.endpoint,
    port: 26257,
    password: rootSecret.password,
    user: rootSecret.username,
    options: rootSecret.options,
    database: event.ResourceProperties.database,
    connectionTimeoutMillis: 10000,
    ssl: {
      rejectUnauthorized: false
    }
  } as ClientConfig)

  await client.connect();

  switch (event.RequestType) {
    case 'Create':
      await client.query(`create user if not exists "${userSecret.username}";`);
      await client.query(`alter user "${userSecret.username}" with password $1;`, [userSecret.password]);
      await client.query(`grant SELECT, UPDATE, DELETE, INSERT, CONNECT on database "${event.ResourceProperties.database}" to "${userSecret.username}";`)
      // This will fail if no tables exist, so just eat the errors
      await client.query(`grant SELECT, UPDATE, DELETE, INSERT on table "${event.ResourceProperties.database}".* to "${userSecret.username}";`).catch(err => null)
      break;
    case 'Delete':
      await client.query(`revoke all privileges on TABLE "${event.ResourceProperties.database}".* from "${userSecret.username}";`).catch(err => null)
      await client.query(`revoke all privileges on DATABASE "${event.ResourceProperties.database}" from "${userSecret.username}";`)
      await client.query(`alter default privileges for all roles revoke all on tables from "${userSecret.username}" cascade;`)
      await client.query(`drop user "${userSecret.username}";`)
  }
  await client.end();
}
