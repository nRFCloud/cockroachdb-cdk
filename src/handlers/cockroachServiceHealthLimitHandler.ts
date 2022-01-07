import { ECS } from 'aws-sdk';
import {
  ServiceDeploymentCompletedEvent,
  ServiceDeploymentFailedEvent,
  ServiceDeploymentInProgressEvent
} from '../lib/types';

const ecsCluster = process.env.ECS_CLUSTER || ""
const serviceName = process.env.SERVICE_NAME || "";

const ECSClient = new ECS()

export async function handler(event: ServiceDeploymentCompletedEvent | ServiceDeploymentFailedEvent | ServiceDeploymentInProgressEvent) {
  console.log(event)
  if (!event.resources[0].endsWith(serviceName)) {
    console.log("Not updating max health for: " + event.resources[0])
    return;
  }

  if (event.detail.eventName === "SERVICE_DEPLOYMENT_IN_PROGRESS") {
    console.log(`Limiting max health for ${serviceName}`)
    await ECSClient.updateService({
      cluster: ecsCluster,
      service: serviceName,
      deploymentConfiguration: {
        maximumPercent: 100
      }
    }).promise()
  } else {
    console.log(`Unlimiting max health for ${serviceName}`)
    await ECSClient.updateService({
      cluster: ecsCluster,
      service: serviceName,
      deploymentConfiguration: {
        maximumPercent: 200
      }
    }).promise()
  }
}
