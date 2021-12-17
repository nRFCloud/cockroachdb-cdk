import { App, CfnOutput, Stack } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, InstanceType, NatInstanceProvider, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { CockroachDBECS } from '../cockroachDBECS';
import { KeyPair } from 'cdk-ec2-key-pair';
import { GatewayVpcEndpointAwsService } from '@aws-cdk/aws-ec2/lib/vpc-endpoint';

export class TestStackECS extends Stack {
  constructor(parent: App) {
    super(parent, 'cockroach-ecs-test', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    });

    const keypair = new KeyPair(this, 'nat-keypair', {
      name: 'ecs-nat-keypair'
    })
    const vpc = new Vpc(this, 'cockroach-vpc', {
      natGateways: 1,
      natGatewayProvider: NatInstanceProvider.instance({
        instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.NANO),
        keyName: keypair.keyPairName
      }),
    })

    vpc.addGatewayEndpoint('s3-endpoint', {
      service: GatewayVpcEndpointAwsService.S3
    })

    const cluster = new CockroachDBECS(this, 'cockroach-cluster', {
      vpc,
      onDemandNodes: 0,
      onDemandMetrics: false,
    })

    new CfnOutput(this, 'ca-crt-output', {
      exportName: 'caCrtParam',
      value: cluster.ca.caCrt.parameterName,
    })

    new CfnOutput(this, 'root-crt-output', {
      exportName: 'rootCrtParam',
      value: cluster.rootCerts.clientCrt.parameterName
    })

    new CfnOutput(this, 'root-key-output', {
      exportName: 'rootKeyParam',
      value: cluster.rootCerts.clientKey.parameterName
    })

    new CfnOutput(this, 'cockroach-endpoint', {
      exportName: 'cockroachEndpoint',
      value: cluster.endpoint,
    })
  }
}

new TestStackECS(new App())
