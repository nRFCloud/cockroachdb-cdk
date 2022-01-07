import { EC2TerminationSuccessful, EC2TerminationUnsuccessful } from '../lib/types';
import { AutoScaling } from 'aws-sdk';

const AutoScalingClient = new AutoScaling()

export async function handler(event: EC2TerminationSuccessful | EC2TerminationUnsuccessful) {
  console.log(event);
  console.log("Instance terminated, resuming instance termination processes")
  await AutoScalingClient.resumeProcesses({
    ScalingProcesses: ["Terminate"],
    AutoScalingGroupName: event.detail.AutoScalingGroupName
  }).promise()
}
