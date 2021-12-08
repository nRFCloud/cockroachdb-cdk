import { App, Stack } from '@aws-cdk/core';
import { CockroachDBEKSCluster } from '../cockroachDBEKSCluster';
import { SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachDBServerlessBridge } from '../cockroachDbServerlessBridge';
import { Secret } from '@aws-cdk/aws-secretsmanager';

export class TestStack extends Stack {
  constructor(parent: App) {
    super(parent, 'cockroach-test', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    const cockroach = new CockroachDBServerlessBridge(this, 'cockroach', {
      rootSecret: Secret.fromSecretName(this, 'root-secret', 'serverless-secret'),
    })

    const backupBucket = new Bucket(this, 'serverless-backup')
    // cockroach.automateBackup(backupBucket)

    const nrfcloudDB = cockroach.addDatabase('nrfcloud-db', 'nrfcloud');
    nrfcloudDB.addUser('db-access-user', 'lambda')
  }
}

new TestStack(new App())
