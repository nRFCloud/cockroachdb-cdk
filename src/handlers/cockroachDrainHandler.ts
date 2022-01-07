import { SQSEvent, SQSHandler, SQSBatchResponse } from 'aws-lambda'
import { LifecycleTerminationEvent } from '../lib/types';
import { AutoScaling, ECS, SQS} from 'aws-sdk';

const ecsCluster = process.env.ECS_CLUSTER || "";
const queueUrl = process.env.QUEUE_URL || "";

const retryDelaySeconds = parseInt(process.env.RETRY_DELAY_SECONDS || "30");

const ECSClient = new ECS()
const SQSClient = new SQS();
const AutoScaleClient = new AutoScaling()

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  console.log(JSON.stringify(event, null, 2))
  const events = event.Records.map(record => ({
    messageId: record.messageId,
    event: JSON.parse(record.body) as LifecycleTerminationEvent["detail"]
  }))

  const results = await Promise.allSettled(events
    .filter(event => event.event.LifecycleTransition === 'autoscaling:EC2_INSTANCE_TERMINATING')
    .map((event) => handleTerminationEvent(event.event).catch((err) => {throw {err, messageId: event.messageId}})))

  const failingMessageIds = [];

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(result.reason.err)
      failingMessageIds.push(result.reason.messageId as string)
    }
  }

  return {
    batchItemFailures: failingMessageIds.map((id) => ({itemIdentifier: id}))
  }
}

async function handleTerminationEvent(event: LifecycleTerminationEvent["detail"]) {
  const {EC2InstanceId, LifecycleHookName, LifecycleActionToken, AutoScalingGroupName} = event;
  const containerInstanceRef = await ECSClient.listContainerInstances({
    cluster: ecsCluster,
    filter: `ec2InstanceId==${EC2InstanceId}`,
    maxResults: 1
  }).promise();
  const containerInstanceId = containerInstanceRef?.containerInstanceArns?.[0];
  if (containerInstanceId == null) {
    console.log(`No container instance found for ${EC2InstanceId}`)
    await AutoScaleClient.completeLifecycleAction({
      AutoScalingGroupName,
      LifecycleActionToken: LifecycleActionToken,
      InstanceId: EC2InstanceId,
      LifecycleHookName,
      LifecycleActionResult: "CONTINUE"
    }).promise()
    return;
  }

  const hasRunning = await hasRunningTasks(containerInstanceId);

  if (hasRunning) {
    console.log(`Drain incomplete for ${containerInstanceId}, requeueing`)
    await SQSClient.sendMessage({
      DelaySeconds: retryDelaySeconds,
      MessageBody: JSON.stringify(event),
      QueueUrl: queueUrl
    }).promise()
  } else {
    console.log(`Drain complete for ${EC2InstanceId} : ${containerInstanceId}`)
    await AutoScaleClient.completeLifecycleAction({
      AutoScalingGroupName,
      LifecycleActionToken: LifecycleActionToken,
      InstanceId: EC2InstanceId,
      LifecycleHookName,
      LifecycleActionResult: "CONTINUE"
    }).promise().catch(err => console.error)
  }
}

async function hasRunningTasks(containerInstanceId: string): Promise<boolean> {
  const {containerInstances} = await ECSClient.describeContainerInstances({
    cluster: ecsCluster,
    containerInstances: [containerInstanceId],
  }).promise();
  const containerInstance = containerInstances?.[0];

  if (containerInstance == null) {
    return false;
  }

  if (containerInstance.status === "ACTIVE") {
    console.log(`Starting drain of ${containerInstanceId}`)
    await ECSClient.updateContainerInstancesState({
      containerInstances: [containerInstanceId],
      cluster: ecsCluster,
      status: 'DRAINING'
    }).promise()
  }

  const [{taskArns: runningTaskArns}, {taskArns: stoppingTaskArns}] = await Promise.all([
    ECSClient.listTasks({
      cluster: ecsCluster,
      containerInstance: containerInstanceId,
      desiredStatus: "RUNNING"
    }).promise(),
    ECSClient.listTasks({
      cluster: ecsCluster,
      containerInstance: containerInstanceId,
      desiredStatus: "STOPPED"
    }).promise()
  ]);

  const taskArns = [...(runningTaskArns || []), ...(stoppingTaskArns || [])];

  if (taskArns.length === 0) {
    return false;
  }

  const {tasks} = await ECSClient.describeTasks({
    cluster: ecsCluster,
    tasks: taskArns
  }).promise()

  console.log(tasks);

  for (const task of (tasks || [])) {
    if (task.lastStatus !== 'STOPPED') {
      console.log(`Container ${containerInstanceId} still has running tasks`)
      return true;
    }
  }

  console.log(`Container ${containerInstanceId} has no running tasks`)
  return false;
}
