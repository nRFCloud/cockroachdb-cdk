import { App, Stack, Tags } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, NatInstanceProvider, Vpc, InstanceType } from '@aws-cdk/aws-ec2';
import {KeyPair} from 'cdk-ec2-key-pair'
import { CockroachDBEKSCluster } from '../cockroachDBEKSCluster';
import { data } from 'aws-cdk/lib/logging';
import { User } from '@aws-cdk/aws-iam';

export class TestStack extends Stack {
  constructor(parent: App) {
    super(parent, 'cockroach-test', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    const keypair = new KeyPair(this, 'nat-keypair', {
      name: 'nat-keypair'
    })

    const vpc = new Vpc(this, 'cockroach-vpc', {
      natGatewayProvider: NatInstanceProvider.instance({
        instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.NANO),
        keyName: keypair.keyPairName
      }),
      natGateways: 1,
    });

    const cockroach = new CockroachDBEKSCluster(this, 'db-cluster', {
      vpc,
      publiclyAvailable: false,
      rootUsername: "nrfcloud"
    })

    cockroach.kubeCluster.awsAuth.addUserMapping(User.fromUserName(this, 'me', 'jfconley'), {groups: ['system:masters', 'cluster-admin']})
    const database = cockroach.addDatabase('nrfcloud-db', 'nrfcloud')

    const dbUser = database.addUser('lambda-user', 'lambda')
  }
}

new TestStack(new App())
