import { LifecycleLaunchEvent } from '../lib/types';
import { AutoScaling, EC2, ECS, SSM } from 'aws-sdk';
import {get, RequestOptions} from "https"
import { IncomingMessage } from 'http';
import { retryWithBackoff } from '../lib/lib';

const getPromise = (options: RequestOptions) => new Promise((resolve: (res: IncomingMessage) => void, reject) => {
  const result = get(options, resolve);
  result.on('error', reject);
})

const ecsCluster = process.env.ECS_CLUSTER;
const serviceName = process.env.SERVICE_NAME || "";

const ECSClient = new ECS()
const EC2Client = new EC2();
const AutoScaleClient = new AutoScaling()

export async function handler(event: LifecycleLaunchEvent) {
  console.log(event)
  const {services} = await ECSClient.describeServices({
    cluster: ecsCluster,
    services: [serviceName]
  }).promise();

  const service = services?.pop();

  if (service == null) {
    console.info("Service is not yet created, continue instance creation")
    await complete(event, "CONTINUE")
    return;
  }

  const {Reservations} = await EC2Client.describeInstances({InstanceIds: [event.detail.EC2InstanceId]}).promise()
  const instance = Reservations?.pop()?.Instances?.pop()

  if (instance?.PrivateDnsName == null) {
    await complete(event, "CONTINUE");
    return;
  }

  const privateDns = instance.PrivateDnsName;

  await retryWithBackoff(async () => {
    const result = await getPromise({
      host: privateDns,
      port: 8080,
      path: "/health",
      rejectUnauthorized: false
    })

    if (result.statusCode != 200) {
      throw new Error(`Health endpoint responded with: ${result.statusCode}`)
    }
  }, 5000, 500)
    .then(() => complete(event, "CONTINUE"))
    .catch(() => complete(event, "ABANDON"))
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
