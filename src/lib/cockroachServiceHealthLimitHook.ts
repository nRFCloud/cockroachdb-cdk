// import { Construct, Duration } from '@aws-cdk/core';
// import { Cluster } from '@aws-cdk/aws-ecs';
// import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
// import { join } from 'path';
// import { Effect, PolicyStatement } from '@aws-cdk/aws-iam';
// import { Rule } from '@aws-cdk/aws-events';
// import { LambdaFunction } from '@aws-cdk/aws-events-targets';
// import { getHandlerPath } from './lib';
//
// export class CockroachServiceHealthLimitHook extends Construct {
//   constructor(scope: Construct, id: string, options: {
//     cluster: Cluster,
//     serviceName: string
//   }) {
//     super(scope, id);
//
//     const {cluster, serviceName} = options
//
//     const serviceHealthLimitHandler = new NodejsFunction(this, 'service-health-limit-handler', {
//       bundling: {
//         minify: true,
//         externalModules: ["aws-sdk"],
//       },
//       environment: {
//         ECS_CLUSTER: cluster.clusterName,
//         SERVICE_NAME: serviceName
//       },
//       memorySize: 4096,
//       timeout: Duration.minutes(1),
//       entry: getHandlerPath('cockroachServiceHealthLimitHandler.js'),
//     })
//
//     serviceHealthLimitHandler.addToRolePolicy(new PolicyStatement({
//       effect: Effect.ALLOW,
//       actions: [
//         "ecs:UpdateService",
//       ],
//       resources: ["*"]
//     }))
//
//     new Rule(this, 'service-health-limit-rule', {
//       enabled: true,
//       eventPattern: {
//         detailType: ["ECS Deployment State Change", "ECS Service Action"],
//         source: ["aws.ecs"],
//         detail: {
//           eventName: ["SERVICE_STEADY_STATE", "SERVICE_DEPLOYMENT_IN_PROGRESS", "SERVICE_DEPLOYMENT_COMPLETED", "SERVICE_DEPLOYMENT_FAILED"]
//         }
//       },
//       targets: [
//         new LambdaFunction(serviceHealthLimitHandler)
//       ]
//     })
//   }
//
// }
