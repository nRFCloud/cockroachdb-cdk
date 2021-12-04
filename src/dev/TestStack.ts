import { App, Stack } from '@aws-cdk/core';
import { CockroachDBEKSCluster } from '../cockroachDBEKSCluster';
import { SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { Bucket } from '@aws-cdk/aws-s3';

export class TestStack extends Stack {
  constructor(parent: App) {
    super(parent, 'cockroach-test', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    const vpc = new Vpc(this, 'cockroach-vpc', {
      subnetConfiguration: [
        {subnetType: SubnetType.PUBLIC, name: 'cockroach-vpc-public'}
      ],
      natGateways: 0,
    })

    const backupBucket = new Bucket(this, 'cockroach-backups');
    const cluster = new CockroachDBEKSCluster(this, 'cockroach-cluster', {
      vpc,
      vpcSubnets: [{subnetType: SubnetType.PUBLIC}],
      desiredNodes: 6,
      rootUsername: "nrfcloud",
      database: "nrfcloud",
      s3ReadBuckets: [backupBucket],
      s3WriteBuckets: [backupBucket]
    })
    cluster.addUser('lambda_user')
    cluster.automateBackup(backupBucket);
  }
}

new TestStack(new App())
