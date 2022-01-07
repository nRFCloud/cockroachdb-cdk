import { Construct, Duration } from '@aws-cdk/core';
import { Cluster, Ec2Service } from '@aws-cdk/aws-ecs';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { AutoScalingGroup, DefaultResult, LifecycleTransition } from '@aws-cdk/aws-autoscaling';
import { Rule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';

export class CockroachStartupTerminationWaitHook extends Construct {
  constructor(scope: Construct, id: string, options: {
    asg: AutoScalingGroup
  }) {
    super(scope, id);

    const {asg} = options
    const waitHandler = new NodejsFunction(this, 'wait-handler', {
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(15),
      entry: join(__dirname, '..', 'handlers', 'cockroachStartupTerminationWaitHandler.js'),
    })

    waitHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "autoscaling:CompleteLifecycleAction",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:RecordLifecycleActionHeartbeat"
      ],
      resources: ["*"]
    }))

    const hook = asg.addLifecycleHook('cockroach-startup-wait-hook', {
      heartbeatTimeout: Duration.minutes(15),
      lifecycleTransition: LifecycleTransition.INSTANCE_LAUNCHING,
      defaultResult: DefaultResult.CONTINUE,
    })

    const startupRule = new Rule(this, 'cockroach-startup-wait-rule', {
      enabled: true,
      eventPattern: {
        source: ["aws.autoscaling"],
        detail: {
          LifecycleHookName: [hook.lifecycleHookName]
        }
      },
      targets: [new LambdaFunction(waitHandler, {
        retryAttempts: 180,
        maxEventAge: Duration.hours(1),
      })]
    })
  }
}
