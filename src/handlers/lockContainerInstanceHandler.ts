import { ECS } from 'aws-sdk';
import { createHash } from 'crypto';

interface TaskStateChangeEvent {
  "version": string,
  "id": string,
  "detail-type": "ECS Task State Change",
  "source": "aws.ecs",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "clusterArn": string,
    "desiredStatus": "RUNNING" | "STOPPED",
    "group": "family:sample-fargate",
    "lastStatus": "RUNNING" | "STOPPED",
    "taskArn": string,
  }
}

type LockState = "LOCKED" | "OPEN"

const ECSClient = new ECS()

export async function handler(event: TaskStateChangeEvent) {
  const containerInstance = await getContainerInstanceArn(event.detail.clusterArn, event.detail.taskArn);
  if (containerInstance == null) {
    return;
  }

  const [,taskFamilyName] = event.detail.group.split(":");

  console.log(`Task state changed`, {containerInstance, task: event.detail.taskArn, service: taskFamilyName})

  switch (event.detail.desiredStatus) {
    case 'RUNNING':
      console.log(`Locking instance ${containerInstance} for ${taskFamilyName}`)
      await setContainerLockState(event.detail.clusterArn, taskFamilyName, containerInstance, "LOCKED")
      break;
    case 'STOPPED':
      console.log(`Unlocking instance ${containerInstance} for ${taskFamilyName}`)
      await setContainerLockState(event.detail.clusterArn, taskFamilyName, containerInstance, "OPEN")
      break;
  }
}

async function getContainerInstanceArn(cluster: string, taskArn: string): Promise<string | undefined> {
  const {tasks} = await ECSClient.describeTasks({
    cluster,
    tasks: [taskArn]
  }).promise()
  const task = tasks?.pop();

  if (task == null) {
    return;
  }

  return task.containerInstanceArn
}

async function setContainerLockState(cluster: string, taskFamilyName: string, containerInstance: string, lockState: LockState) {
  await ECSClient.putAttributes({
    cluster,
    attributes: [{
      targetType: "container-instance",
      targetId: containerInstance,
      name: generateLockName(taskFamilyName),
      value: lockState
    }]
  }).promise()
}

export function generateLockName(taskFamilyName: string) {
  return createHash('sha1').update(taskFamilyName).digest().toString('hex') + ".lock"
}
