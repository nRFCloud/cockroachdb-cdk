import { App, Stack } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, InstanceType, NatInstanceProvider, Vpc } from '@aws-cdk/aws-ec2';
import { YugabyteEKSCluster } from '../YugabyteEKSCluster';

export class TestStack extends Stack {
  constructor(parent: App) {
    super(parent, 'yugabyte-test', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    // const vpc = new Vpc(this, 'cockroach-vpc', {
    //   subnetConfiguration: [
    //     {subnetType: SubnetType.PUBLIC, name: 'cockroach-vpc-public'}
    //   ],
    //   natGateways: 0,
    // })

    // const cluster = new CockroachDBEKSCluster(this, 'cockroach-cluster', {
    //   vpc,
    //   vpcSubnets: [{
    //     subnetType: SubnetType.PUBLIC
    //   }]
    // })

    const yugabyteCluster = new YugabyteEKSCluster(this, 'yugabyte-cluster', {
      vpc: new Vpc(this, 'yugabyte-vpc', {
        maxAzs: 3,
        natGateways: 1,
        natGatewayProvider: NatInstanceProvider.instance({instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.NANO)})
      }),
    })

  }
}

new TestStack(new App())
