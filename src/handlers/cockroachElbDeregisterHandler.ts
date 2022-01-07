// import { EC2, ECS, ELBv2 } from 'aws-sdk';
// import { execFileSync } from 'child_process';
//
// interface TaskStateChangeEvent {
//   "version": string,
//   "id": string,
//   "detail-type": "ECS Task State Change",
//   "source": "aws.ecs",
//   "account": string,
//   "time": string,
//   "region": string,
//   "resources": [
//     string
//   ],
//   "detail": {
//     "clusterArn": string,
//     "desiredStatus": "STOPPED",
//     "group": string,
//     "lastStatus": "RUNNING",
//     "taskArn": string,
//   }
// }
//
// const WebELB = process.env.WEB_ELB_TARGET || "";
// const SQLELB = process.env.SQL_ELB_TARGET || "";
// const clusterName = process.env.CLUSTER_NAME || "";
//
// const ECSClient = new ECS()
// const EC2Client = new EC2()
// const ELBClient = new ELBv2()
//
// export async function handler(event: TaskStateChangeEvent) {
//   const {clusterArn: cluster, taskArn} = event.detail
//
//   const {tasks} = await ECSClient.describeTasks({
//     cluster,
//     tasks: [taskArn]
//   }).promise()
//   const task = tasks?.pop();
//
//   if (task?.containerInstanceArn == null) {
//     console.error("Could not find container instance for: " + taskArn)
//     console.error(task)
//     return;
//   }
//
//   const {containerInstances} = await ECSClient.describeContainerInstances({
//     cluster,
//    containerInstances: [task.containerInstanceArn],
//   }).promise()
//
//   const containerInstance = containerInstances?.pop();
//
//   if (containerInstance?.ec2InstanceId == null) {
//     console.error("Could not get ec2 instance id: " + containerInstance)
//     return;
//   }
//
//   const instanceId = containerInstance.ec2InstanceId;
//
//   const {Reservations} = await EC2Client.describeInstances({
//     InstanceIds: [instanceId],
//     MaxResults: 1
//   }).promise()
//
//   const instance = Reservations?.pop()?.Instances?.pop()
//
//   if (instance?.PrivateDnsName == null) {
//     console.error("Could not get instance data: " + instanceId)
//     return
//   }
//
//   console.log("Deregistering instance: " + instanceId)
//   console.log(`Private DNS: ${instance.PrivateDnsName}`)
//
//   await ELBClient.deregisterTargets({
//     TargetGroupArn: SQLELB,
//     Targets: [{Id: instanceId}],
//   }).promise()
//   console.log("Deregistered SQL endpoint")
//
//
//   await ELBClient.deregisterTargets({
//     TargetGroupArn: WebELB,
//     Targets: [{Id: instanceId}]
//   }).promise()
//   console.log("Deregistered Web portal")
//
//   execFileSync('cockroach', [
//     "node",
//     "drain",
//     `--host=${instance.PrivateDnsName}`,
//     `--cluster-name=${clusterName}`,
//     `--`
//   ])
// }
