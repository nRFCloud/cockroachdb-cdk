import { AutoScaling, ECS, SSM, EC2 } from 'aws-sdk'
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync, execSync, spawn } from 'child_process';
import { LifecycleTerminationEvent, RebalanceRecommendationEvent, TaskStateChangeEvent } from '../lib/types';
import { promisify } from 'util';

const certsDir = join(tmpdir(), randomUUID(), 'certs')
mkdirSync(certsDir, {recursive: true})
const caCrtPath = join(certsDir, 'ca.crt');
const rootCrtPath = join(certsDir, 'client.root.crt');
const rootKeyPath = join(certsDir, 'client.root.key');
const timeoutAsync = promisify((ms: number, cb: (err: any) => void) => setTimeout(cb, ms))

// writeFileSync(caCrtPath, process.env.COCKROACH_CA_CRT || "", {mode: 0o600})
// writeFileSync(rootCrtPath, process.env.COCKROACH_ROOT_CRT || "", {mode: 0o600})
// writeFileSync(rootKeyPath, process.env.COCKROACH_ROOT_KEY || "", {mode: 0o600})
const caCrtParam = process.env.COCKROACH_CA_CRT_PARAM || "";
const rootCrtParam = process.env.COCKROACH_ROOT_CRT_PARAM || "";
const rootKeyParam = process.env.COCKROACH_ROOT_KEY_PARAM || "";

const clusterName = process.env.CLUSTER_NAME;
const ecsCluster = process.env.ECS_CLUSTER;

const SSMClient = new SSM();
const ECSClient = new ECS()
const EC2Client = new EC2();
const AutoScaleClient = new AutoScaling()

interface TaskStoppingEvent extends TaskStateChangeEvent {
  detail: {
    "clusterArn": string,
    "desiredStatus": "STOPPED",
    "group": string,
    "lastStatus": "RUNNING",
    "taskArn": string,
  }
}

const ssmPull = Promise.all([
  SSMClient.getParameter({Name: caCrtParam, WithDecryption: true}).promise(),
  SSMClient.getParameter({Name: rootCrtParam, WithDecryption: true}).promise(),
  SSMClient.getParameter({Name: rootKeyParam, WithDecryption: true}).promise(),
]).then(([{Parameter: caCrtValue}, {Parameter: rootCrtValue}, {Parameter: rootKeyValue}]) => {
  writeFileSync(caCrtPath, caCrtValue?.Value || "", {mode: 0o600})
  writeFileSync(rootCrtPath, rootCrtValue?.Value || "", {mode: 0o600})
  writeFileSync(rootKeyPath, rootKeyValue?.Value || "", {mode: 0o600})
})

export async function handler(event: LifecycleTerminationEvent | RebalanceRecommendationEvent | TaskStoppingEvent) {
  console.log(event)
  switch (event['detail-type']) {
    case 'EC2 Instance-terminate Lifecycle Action':
      await handleTermination(event);
      break;
    case 'EC2 Instance Rebalance Recommendation':
      await handleRebalance(event);
      break;
    case 'ECS Task State Change':
      await handleTaskStopping(event);
      break;
  }
}

async function handleTaskStopping(event: TaskStoppingEvent) {
  const {taskArn} = event.detail;
  const info = await getInstanceInfoForTask(taskArn);

  if (info != null) {
    await stopCockroach(info.privateDnsName, true, false)
  }
}

async function handleRebalance(event: RebalanceRecommendationEvent) {
  console.log(`Handling rebalance event`)
  const info = await getInstanceInfo(event.detail['instance-id']);

  if (info != null) {
    await stopCockroach(info.privateDnsName, true).catch(err => null);
    await ECSClient.updateContainerInstancesState({
      status: "DRAINING",
      containerInstances: [info.containerInstanceId],
      cluster: ecsCluster,
    }).promise().catch(err => null)
    await AutoScaleClient.terminateInstanceInAutoScalingGroup({
      InstanceId: event.detail['instance-id'],
      ShouldDecrementDesiredCapacity: false,
    }).promise()
  }
}

async function handleTermination(event: LifecycleTerminationEvent) {
  console.log("Handling termination event")
  const {detail: {AutoScalingGroupName, LifecycleHookName, EC2InstanceId, LifecycleActionToken}} = event;
  const info = await getInstanceInfo(EC2InstanceId);

  if (info != null) {
    // await AutoScaleClient.suspendProcesses({
    //   AutoScalingGroupName,
    //   ScalingProcesses: ["Terminate"]
    // }).promise()
    await stopCockroach(info.privateDnsName, true);
    await AutoScaleClient.completeLifecycleAction({
      AutoScalingGroupName,
      LifecycleActionToken: LifecycleActionToken,
      InstanceId: EC2InstanceId,
      LifecycleHookName,
      LifecycleActionResult: "CONTINUE"
    }).promise()
  }
}

async function stopCockroach(privateDnsName: string, drain = true, decommission = true) {
  await ssmPull;

  if (decommission) {
    console.log(execFileSync("cockroach", [
      "node",
      "decommission",
      `--host=${privateDnsName}:26258`,
      '--self',
      `--cluster-name=${clusterName}`,
      `--certs-dir=${certsDir}`,
      '--wait=none'
    ]).toString('utf8'))
  }

  if (drain) {
    // Drain the node immediately, just in case the SIGTERM doesn't get sent
    execFileSync("cockroach", [
      "node",
      "drain",
      `--host=${privateDnsName}:26258`,
      `--cluster-name=${clusterName}`,
      `--certs-dir=${certsDir}`,
    ])
  }
}

async function getInstanceInfoForTask(taskArn: string): Promise<{ containerInstanceId: string, privateDnsName: string } | void> {
  const {tasks} = await ECSClient.describeTasks({
    cluster: ecsCluster,
    tasks: [taskArn]
  }).promise()
  const task = tasks?.pop();

  if (task?.containerInstanceArn == null) {
    console.error("Could not find container instance for: " + taskArn)
    console.error(task)
    return;
  }

  const {containerInstances} = await ECSClient.describeContainerInstances({
    cluster: ecsCluster,
    containerInstances: [task.containerInstanceArn],
  }).promise()

  const containerInstance = containerInstances?.pop();

  if (containerInstance?.ec2InstanceId == null) {
    console.error("Could not get ec2 instance id: " + containerInstance)
    return;
  }

  const instanceId = containerInstance.ec2InstanceId;

  return getInstanceInfo(instanceId);
}

async function getInstanceInfo(instanceId: string): Promise<{ containerInstanceId: string, privateDnsName: string } | void> {
  const containerInstanceRef = await ECSClient.listContainerInstances({
    cluster: ecsCluster,
    filter: `ec2InstanceId==${instanceId}`,
    maxResults: 1
  }).promise();
  const containerInstanceId = containerInstanceRef?.containerInstanceArns?.[0];
  if (containerInstanceId == null) {
    console.error("Could not retrieve container instance")
    console.error(containerInstanceRef)
    return;
  }

  console.log(`Found container instance: ${containerInstanceId}`)

  const {Reservations: instanceReservations} = await EC2Client.describeInstances({
    InstanceIds: [instanceId]
  }).promise()

  const instance = instanceReservations?.pop()?.Instances?.pop();

  if (instance?.PrivateDnsName == null) {
    console.error("Could not retrieve instance info");
    console.error(instanceReservations)
    return;
  }

  return {
    containerInstanceId,
    privateDnsName: instance.PrivateDnsName,
  }
}
