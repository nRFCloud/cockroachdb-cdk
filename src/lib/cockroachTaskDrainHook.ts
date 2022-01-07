import { Construct, Duration } from '@aws-cdk/core';
import { AutoScalingGroup, DefaultResult, LifecycleTransition } from '@aws-cdk/aws-autoscaling';
import { Cluster, Ec2Service } from '@aws-cdk/aws-ecs';
import { Queue } from '@aws-cdk/aws-sqs';
import { QueueHook } from '@aws-cdk/aws-autoscaling-hooktargets';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { CockroachCLILayer } from './cockroachCLILayer';
import { join } from 'path';
import { SqsEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';

export class CockroachTaskDrainHook extends Construct {
  constructor(scope: Construct, id: string, options: {
    asg: AutoScalingGroup,
    cluster: Cluster,
  }) {
    super(scope, id);
    const {cluster, asg} = options;

    const queue = new Queue(this, 'drain-queue', {visibilityTimeout: Duration.minutes(1)});

    const hook = asg.addLifecycleHook('drain-hook', {
      lifecycleTransition: LifecycleTransition.INSTANCE_TERMINATING,
      heartbeatTimeout: Duration.hours(1),
      defaultResult: DefaultResult.CONTINUE,
      notificationTarget: new QueueHook(queue)
    });

    const handler = new NodejsFunction(this, 'drain-handler', {
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(1),
      entry: join(__dirname, '..', 'handlers', 'cockroachDrainHandler.js'),
      environment: {
        ECS_CLUSTER: cluster.clusterName,
        QUEUE_URL: queue.queueUrl,
        RETRY_DELAY_SECONDS: "30",
      }
    })

    queue.grantSendMessages(handler)

    handler.addEventSource(new SqsEventSource(queue, {reportBatchItemFailures: true}))

    handler.addToRolePolicy(new PolicyStatement({
      resources: ["*"],
      actions: [
        "autoscaling:CompleteLifecycleAction",
        "autoscaling:SuspendProcesses",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:ResumeProcesses",
        "ecs:DescribeContainerInstances",
        "ecs:DescribeTasks",
        "ecs:ListContainerInstances",
        "ecs:ListTasks",
        "ecs:UpdateContainerInstancesState"
      ],
      effect: Effect.ALLOW,
    }))
  }

}
