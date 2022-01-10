import { LifecycleLaunchEvent } from '../lib/types';
import { AutoScaling, EC2, ECS, SSM } from 'aws-sdk';
import { retryWithBackoff } from '../lib/lib';

const AutoScaleClient = new AutoScaling()

export async function handler(event: LifecycleLaunchEvent) {
  console.log(event)

  await retryWithBackoff(async () => {
    if (await isTerminatingInstances(event.detail.AutoScalingGroupName)) {
      throw new Error("Waiting for instance termination")
    }
  }, 1000, 500)
    .then(() => complete(event, "CONTINUE"))
    .catch(async (err) => {
      await AutoScaleClient.recordLifecycleActionHeartbeat({
        InstanceId: event.detail.EC2InstanceId,
        LifecycleHookName: event.detail.LifecycleHookName,
        AutoScalingGroupName: event.detail.AutoScalingGroupName,
        LifecycleActionToken: event.detail.LifecycleActionToken
      }).promise()
      throw err;
    })
}

async function complete(event: LifecycleLaunchEvent, result: "CONTINUE" | "ABANDON") {
  await AutoScaleClient.completeLifecycleAction({
    AutoScalingGroupName: event.detail.AutoScalingGroupName,
    LifecycleActionToken: event.detail.LifecycleActionToken,
    InstanceId: event.detail.EC2InstanceId,
    LifecycleHookName: event.detail.LifecycleHookName,
    LifecycleActionResult: result
  }).promise()
}

async function isTerminatingInstances(asg: string) {
  const {AutoScalingGroups: [{Instances}]} = await AutoScaleClient.describeAutoScalingGroups({
    AutoScalingGroupNames: [asg],
    MaxRecords: 1
  }).promise();

  const terminating = (Instances?.filter(inst => inst.LifecycleState.includes("Terminating")) || [])
  return terminating.length > 0;
}
