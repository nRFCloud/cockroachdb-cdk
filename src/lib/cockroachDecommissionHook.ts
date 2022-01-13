import { Construct, Duration } from '@aws-cdk/core';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { CockroachCLILayer } from './cockroachCLILayer';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { AutoScalingGroup, DefaultResult, LifecycleTransition } from '@aws-cdk/aws-autoscaling';
import { Rule } from '@aws-cdk/aws-events';
import { CloudWatchLogGroup, LambdaFunction } from '@aws-cdk/aws-events-targets';
import { LogGroup } from '@aws-cdk/aws-logs';
import { Cluster, Ec2Service } from '@aws-cdk/aws-ecs';
import { CockroachCA } from '../resources/cockroachCA';
import { CockroachClientCertificates } from '../resources/cockroachClientCertificates';
import { getHandlerPath } from './lib';

export class CockroachDecommissionHook extends Construct {
  constructor(scope: Construct, id: string,options: {
    asg: AutoScalingGroup,
    cluster: Cluster,
    ca: CockroachCA,
    rootCerts: CockroachClientCertificates,
  }) {
    super(scope, id);
    const {ca, cluster, asg, rootCerts} = options

    const decommissionHandler = new NodejsFunction(this, 'cockroach-decommission-handler', {
      vpc: cluster.vpc,
      layers: [new CockroachCLILayer(this, 'cockroach-cli')],
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(1),
      entry: getHandlerPath('cockroachDecommissionHandler.js'),
      environment: {
        CLUSTER_NAME: 'cockroach',
        ECS_CLUSTER: cluster.clusterName,
        COCKROACH_CA_CRT_PARAM: ca.caCrt.parameterName,
        COCKROACH_ROOT_CRT_PARAM: rootCerts.clientCrt.parameterName,
        COCKROACH_ROOT_KEY_PARAM: rootCerts.clientKey.parameterName
      }
    })

    ca.caCrt.grantRead(decommissionHandler);
    rootCerts.clientCrt.grantRead(decommissionHandler);
    rootCerts.clientKey.grantRead(decommissionHandler)
    decommissionHandler.addToRolePolicy(new PolicyStatement({
      resources: ["*"],
      actions: [
        "autoscaling:CompleteLifecycleAction",
        "autoscaling:SuspendProcesses",
        "ecs:DescribeContainerInstances",
        "ecs:DescribeTasks",
        "ecs:ListContainerInstances",
        "ecs:ListTasks",
        "ecs:UpdateContainerInstancesState",
        "ec2:DescribeInstances"
      ],
      effect: Effect.ALLOW,
    }))

    const hook = asg.addLifecycleHook('cockroach-termination-hook', {
      defaultResult: DefaultResult.CONTINUE,
      heartbeatTimeout: Duration.minutes(5),
      lifecycleTransition: LifecycleTransition.INSTANCE_TERMINATING
    })

    new Rule(this, 'cockroach-decommission-rule', {
      enabled: true,
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance-terminate Lifecycle Action'],
        detail: {
        LifecycleHookName: [hook.lifecycleHookName]
        }
      },
      targets: [
        new CloudWatchLogGroup(new LogGroup(this, 'asg-terminate')),
        new LambdaFunction(decommissionHandler)
      ]
    })
  }

}
