import { Construct, Duration, isResolvableObject } from '@aws-cdk/core';
import { Cluster, Ec2Service, Ec2TaskDefinition, PlacementConstraint } from '@aws-cdk/aws-ecs';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { Rule } from '@aws-cdk/aws-events';
import { join } from 'path';
import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import { generateLockName } from '../handlers/lockContainerInstanceHandler';
import { CloudWatchLogGroup, LambdaFunction } from '@aws-cdk/aws-events-targets';
import { LogGroup } from '@aws-cdk/aws-logs';

export class LockContainerInstanceHook extends Construct {
  constructor(scope: Construct, id: string, options: {
    cluster: Cluster,
  }) {
    super(scope, id);
    const {cluster} = options

    const lockHandler = new NodejsFunction(this, 'lock-handler', {
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      memorySize: 4096,
      timeout: Duration.minutes(1),
      entry: join(__dirname, '..', 'handlers', 'lockContainerInstanceHandler.js')
    })

    const lockRule = new Rule(this,'lock-container-instance-rule', {
      enabled: true,
      eventPattern: {
        detailType: ["ECS Task State Change"],
        source: ["aws.ecs"],
        detail: {
          launchType: ["EC2"],
          lastStatus: ["RUNNING", "DEPROVISIONING", "STOPPED"],
          desiredStatus: ["RUNNING", "STOPPED"],
          clusterArn: [cluster.clusterArn]
        }
      },
      targets: [
        new LambdaFunction(lockHandler, {retryAttempts: 3})
      ]
    })

    lockHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'ecs:PutAttributes',
        'ecs:DescribeTasks'
      ],
      resources: ["*"]
    }))
  }

  generateLockName(serviceName: string) {
    if (isResolvableObject(serviceName)) {
      throw new Error("Service name must be known at compile time to generate a lock name")
    }
    return generateLockName(serviceName)
  }

  generatePlacementConstraint(serviceName: string): PlacementConstraint {
    const lockName = this.generateLockName(serviceName);
    return PlacementConstraint.memberOf(`attribute:${lockName} == OPEN or attribute:${lockName} not_exists`)
  }
}
