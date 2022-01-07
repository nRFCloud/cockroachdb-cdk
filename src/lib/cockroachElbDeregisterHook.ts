import { Construct, Duration } from '@aws-cdk/core';
import { Rule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { Cluster } from '@aws-cdk/aws-ecs';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import {NetworkTargetGroup} from '@aws-cdk/aws-elasticloadbalancingv2'
import { CockroachCLILayer } from './cockroachCLILayer';
import { CockroachCA } from '../resources/cockroachCA';
import { CockroachClientCertificates } from '../resources/cockroachClientCertificates';

export class CockroachElbDeregisterHook extends Construct {
  constructor(scope: Construct, id: string, options: {
    cluster: Cluster,
    ca: CockroachCA,
    rootCerts: CockroachClientCertificates,
  }) {
    super(scope, id);

    const {cluster, ca, rootCerts} = options

    const deregisterTargetHandler = new NodejsFunction(this, 'deregister-target-handler', {
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      vpc: cluster.vpc,
      layers: [new CockroachCLILayer(this, 'cockroach-cli')],
      environment: {
        CLUSTER_NAME: 'cockroach',
        ECS_CLUSTER: cluster.clusterName,
        COCKROACH_CA_CRT_PARAM: ca.caCrt.parameterName,
        COCKROACH_ROOT_CRT_PARAM: rootCerts.clientCrt.parameterName,
        COCKROACH_ROOT_KEY_PARAM: rootCerts.clientKey.parameterName,
      },
      memorySize: 4096,
      timeout: Duration.minutes(1),
      entry: join(__dirname, '..', 'handlers', 'cockroachDecommissionHandler.js'),
    })

    ca.caCrt.grantRead(deregisterTargetHandler);
    rootCerts.clientCrt.grantRead(deregisterTargetHandler);
    rootCerts.clientKey.grantRead(deregisterTargetHandler)
    deregisterTargetHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ecs:DescribeContainerInstances",
        "ecs:ListContainerInstances",
        "ecs:ListTasks",
        'ecs:DescribeTasks',
        'elasticloadbalancing:DeregisterTargets',
        "ec2:DescribeInstances"
      ],
      resources: ["*"]
    }))

    const deregisterRule = new Rule(this,'deregister-rule', {
      enabled: true,
      eventPattern: {
        detailType: ["ECS Task State Change"],
        source: ["aws.ecs"],
        detail: {
          launchType: ["EC2"],
          lastStatus: ["DEACTIVATING"],
          desiredStatus: ["STOPPED"],
          clusterArn: [cluster.clusterArn]
        }
      },
      targets: [
        new LambdaFunction(deregisterTargetHandler, {retryAttempts: 3})
      ]
    })
  }

}
