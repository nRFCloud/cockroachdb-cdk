import { App, CfnOutput, Duration, RemovalPolicy, Stack } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, InstanceType, NatInstanceProvider, Vpc } from '@aws-cdk/aws-ec2';
import {
  BigProductionInstanceRequirements,
  CockroachDBECS,
  ProductionInstanceRequirements,
  SmallProductionInstanceRequirements
} from '../cockroachDBECS';
import { KeyPair } from 'cdk-ec2-key-pair';
import { GatewayVpcEndpointAwsService } from '@aws-cdk/aws-ec2/lib/vpc-endpoint';
import { Bucket } from '@aws-cdk/aws-s3';
import { MachineImageType } from '@aws-cdk/aws-ecs';

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
      nodes: 6,
      defaultReplicationFactor: 5,
      onDemandMetrics: false,
      enhancedMetrics: false,
      adminUsername: "nrfcloud",
      instanceRequirements: BigProductionInstanceRequirements,
      publiclyAvailable: true,
      instanceAmi: MachineImageType.AMAZON_LINUX_2
    })

    const backupBucket = new Bucket(this, 'backup-bucket', {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          enabled: true,
          expiration: Duration.days(5)
        }
      ]
    });

    cluster.automateBackup(backupBucket, undefined)

    const db = cluster.addDatabase('db', 'nrfcloud')

    const user = db.addUser('user', 'lambda')

    // cluster.configureBouncer(user);

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
