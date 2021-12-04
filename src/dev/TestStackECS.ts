import { App, Stack } from '@aws-cdk/core';
import { CockroachDBEKSCluster } from '../cockroachDBEKSCluster';
import { InstanceClass, InstanceSize, InstanceType, NatInstanceProvider, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { CockroachDBECSFargate } from '../cockroachDBECSFargate';

export class TestStackECS extends Stack {
  constructor(parent: App) {
    super(parent, 'cockroach-ecs', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    const vpc = new Vpc(this, 'cockroach-vpc', {
      natGateways: 1,
      natGatewayProvider: NatInstanceProvider.instance({
        instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.NANO)
      })
    })

    const cluster = new CockroachDBECSFargate(this, 'cockroach-cluster', {
      vpc
    })

  }
}

new TestStackECS(new App())
