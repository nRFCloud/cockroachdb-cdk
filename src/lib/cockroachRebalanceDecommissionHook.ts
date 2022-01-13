import { Construct, Duration } from '@aws-cdk/core';
import { AutoScalingGroup, DefaultResult, LifecycleTransition } from '@aws-cdk/aws-autoscaling';
import { Cluster, Ec2Service } from '@aws-cdk/aws-ecs';
import { CockroachCA } from '../resources/cockroachCA';
import { CockroachClientCertificates } from '../resources/cockroachClientCertificates';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { CockroachCLILayer } from './cockroachCLILayer';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { Rule } from '@aws-cdk/aws-events';
import { CloudWatchLogGroup, LambdaFunction } from '@aws-cdk/aws-events-targets';
import { LogGroup } from '@aws-cdk/aws-logs';
import { getHandlerPath } from './lib';

export class CockroachRebalanceDecommissionHook extends Construct {
  constructor(scope: Construct, id: string,options: {
    cluster: Cluster,
    ca: CockroachCA,
    rootCerts: CockroachClientCertificates,
  }) {
    super(scope, id);
    const {ca, cluster, rootCerts} = options

    const rebalanceHandler = new NodejsFunction(this, 'cockroach-rebalance-handler', {
      vpc: cluster.vpc,
      layers: [new CockroachCLILayer(this, 'cockroach-cli')],
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(5),
      entry: getHandlerPath('cockroachDecommissionHandler.js'),
      environment: {
        CLUSTER_NAME: 'cockroach',
        ECS_CLUSTER: cluster.clusterName,
        COCKROACH_CA_CRT_PARAM: ca.caCrt.parameterName,
        COCKROACH_ROOT_CRT_PARAM: rootCerts.clientCrt.parameterName,
        COCKROACH_ROOT_KEY_PARAM: rootCerts.clientKey.parameterName,
      }
    })

    ca.caCrt.grantRead(rebalanceHandler);
    rootCerts.clientCrt.grantRead(rebalanceHandler);
    rootCerts.clientKey.grantRead(rebalanceHandler)
    rebalanceHandler.addToRolePolicy(new PolicyStatement({
      resources: ["*"],
      actions: [
        "ecs:DescribeContainerInstances",
        "ecs:DescribeTasks",
        "ecs:ListContainerInstances",
        "ecs:ListTasks",
        "ecs:UpdateContainerInstancesState",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeInstances"
      ],
      effect: Effect.ALLOW,
    }))

    new Rule(this, 'cockroach-rebalance-rule', {
      enabled: true,
      eventPattern: {
        source: ['aws.ec2'],
        // resources: [ asg.autoScalingGroupArn ],
        detailType: ['EC2 Instance Rebalance Recommendation'],
      },
      targets: [
        new CloudWatchLogGroup(new LogGroup(this, 'ec2-rebalance')),
        new LambdaFunction(rebalanceHandler)
      ]
    })
  }
}
