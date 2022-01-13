// import { Construct, Duration } from '@aws-cdk/core';
// import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
// import { CockroachCLILayer } from './cockroachCLILayer';
// import { join } from 'path';
// import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
// import { Rule } from '@aws-cdk/aws-events';
// import { AutoScalingGroup } from '@aws-cdk/aws-autoscaling';
// import { LambdaFunction } from '@aws-cdk/aws-events-targets';
// import { getHandlerPath } from './lib';
//
// export class CockroachTerminatedHook extends Construct {
//   constructor(scope: Construct, id: string, options: {asg: AutoScalingGroup}) {
//     super(scope, id);
//
//     const handler = new NodejsFunction(this, 'cockroach-terminated-handler', {
//       bundling: {
//         minify: true,
//         externalModules: ["aws-sdk"],
//       },
//       memorySize: 4096,
//       timeout: Duration.minutes(5),
//       entry: getHandlerPath('cockroachTerminatedHandler.js'),
//     })
//
//     handler.addToRolePolicy(new PolicyStatement({
//       resources: ["*"],
//       actions: [
//         "autoscaling:ResumeProcesses",
//       ],
//       effect: Effect.ALLOW,
//     }))
//
//     new Rule(this, 'cockroach-terminated-hook', {
//       enabled: true,
//       eventPattern: {
//         source: ['aws.autoscaling'],
//         detailType: ["EC2 Instance Terminate Successful"],
//         resources: [options.asg.autoScalingGroupArn]
//       },
//       targets: [new LambdaFunction(handler)]
//     })
//   }
//
// }
