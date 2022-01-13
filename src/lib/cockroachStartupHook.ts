import { Construct, Duration } from '@aws-cdk/core';
import { Cluster, Ec2Service } from '@aws-cdk/aws-ecs';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { AutoScalingGroup, DefaultResult, LifecycleTransition } from '@aws-cdk/aws-autoscaling';
import { Rule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { getHandlerPath } from './lib';

export class CockroachStartupHook extends Construct {
  constructor(scope: Construct, id: string, options: {
    cluster: Cluster,
    service: Ec2Service,
    asg: AutoScalingGroup
  }) {
    super(scope, id);

    const {cluster, service, asg} = options
    const startupHandler = new NodejsFunction(this, 'cockroach-startup-handler', {
      vpc: cluster.vpc,
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(5),
      entry: getHandlerPath('cockroachStartupHandler.js'),
      environment: {
        ECS_CLUSTER: cluster.clusterName,
        SERVICE_NAME: service.serviceName
      }
    })

    startupHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ecs:DescribeServices",
        "ec2:DescribeInstances",
        "autoscaling:CompleteLifecycleAction",
      ],
      resources: ["*"]
    }))

    const hook = asg.addLifecycleHook('cockroach-startup-hook', {
      heartbeatTimeout: Duration.minutes(6),
      lifecycleTransition: LifecycleTransition.INSTANCE_LAUNCHING,
      defaultResult: DefaultResult.ABANDON,
    })

    const startupRule = new Rule(this, 'cockroach-startup-rule', {
      enabled: true,
      eventPattern: {
        source: ["aws.autoscaling"],
        detail: {
          LifecycleHookName: [hook.lifecycleHookName]
        }
      },
      targets: [new LambdaFunction(startupHandler)]
    })
  }
}
