export interface CustomResourceProviderRequest<Type extends `Custom::${string}` = any, Data extends object = {[key: string]: any}> {
  /**
   * The type of lifecycle event: Create, Update or Delete.
   */
  RequestType: 'Create' | 'Update' | 'Delete';
  /**
   * The template developer-chosen name (logical ID) of the custom resource in the AWS CloudFormation template.
   */
  LogicalResourceId: string;
  /**
   * This field will only be present for Update and Delete events and includes the value returned in PhysicalResourceId of the previous operation.
   */
  PhysicalResourceId: string;
  /**
   * This field contains the properties defined in the template for this custom resource.
   */
  ResourceProperties: Data,
  /**
   * This field will only be present for Update events and contains the resource properties that were declared previous to the update request.
   */
  OldResourceProperties: Data,
  /**
   * The resource type defined for this custom resource in the template. A provider may handle any number of custom resource types.
   */
  ResourceType: Type;
  /**
   * A unique ID for the request
   */
  RequestId: string;
  /**
   * The ARN that identifies the stack that contains the custom resource.
   */
  StackId: string;
}

export interface CustomResourceProviderResponse<T extends object = {[key: string]: any}> {
  PhysicalResourceId: string;
  Data: T;
  [key: string]: any;
}

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] }

export interface CockroachDBUserSecret {
  username: string;
  password: string;
  endpoint: string;
  isAdmin: boolean;
  port: number;
  options: string;
}

export interface LifecycleTerminationEvent {
  "version": number,
  "id": string,
  "detail-type": "EC2 Instance-terminate Lifecycle Action",
  "source": "aws.autoscaling",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "LifecycleActionToken": string,
    "AutoScalingGroupName": string,
    "LifecycleHookName": string,
    "EC2InstanceId": string,
    "LifecycleTransition": string,
    "NotificationMetadata": string
  }
}

export interface LifecycleLaunchEvent {
  "version": string,
  "id": string,
  "detail-type": "EC2 Instance-launch Lifecycle Action",
  "source": "aws.autoscaling",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "LifecycleActionToken": string,
    "AutoScalingGroupName": string,
    "LifecycleHookName": string,
    "EC2InstanceId": string,
    "LifecycleTransition": "autoscaling:EC2_INSTANCE_LAUNCHING",
    "NotificationMetadata": string
  }
}

export interface RebalanceRecommendationEvent {
  "version": string,
  "id": string,
  "detail-type": "EC2 Instance Rebalance Recommendation",
  "source": "aws.ec2",
  "account": string,
  "time": string,
  "region": string,
  "resources": [string],
  "detail": {
    "instance-id": string
  }
}

export interface TaskStateChangeEvent {
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
    "desiredStatus": string,
    "group": string,
    "lastStatus": string,
    "taskArn": string,
  }
}

export interface ServiceDeploymentInProgressEvent {
  "version": string,
  "id": string,
  "detail-type": "ECS Deployment State Change",
  "source": "aws.ecs",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "eventType": "INFO",
    "eventName": "SERVICE_DEPLOYMENT_IN_PROGRESS",
    "deploymentId": string,
    "updatedAt": string,
    "reason": string
  }
}

export interface ServiceDeploymentCompletedEvent {
  "version": string,
  "id": string,
  "detail-type": "ECS Deployment State Change",
  "source": "aws.ecs",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "eventType": "INFO",
    "eventName": "SERVICE_DEPLOYMENT_COMPLETED",
    "deploymentId": string,
    "updatedAt": string,
    "reason": string
  }
}

export interface ServiceDeploymentFailedEvent {
  "version": string,
  "id": string,
  "detail-type": "ECS Deployment State Change",
  "source": "aws.ecs",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string
  ],
  "detail": {
    "eventType": "ERROR",
    "eventName": "SERVICE_DEPLOYMENT_FAILED",
    "deploymentId": string,
    "updatedAt": string,
    "reason": string
  }
}

export interface EC2TerminationSuccessful {
  "version": string,
  "id": string,
  "detail-type": "EC2 Instance Terminate Successful",
  "source": "aws.autoscaling",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string,
    string
  ],
  "detail": {
    "StatusCode": "InProgress",
    "Description": "Terminating EC2 instance: i-12345678",
    "AutoScalingGroupName": string,
    "ActivityId": string,
    "RequestId": string,
    "StatusMessage": string,
    "EndTime": string,
    "EC2InstanceId": string,
    "StartTime": string,
    "Cause": string
  }
}

export interface EC2TerminationUnsuccessful {
  "version": string,
  "id": string,
  "detail-type": "EC2 Instance Terminate Unsuccessful",
  "source": "aws.autoscaling",
  "account": string,
  "time": string,
  "region": string,
  "resources": [
    string,
    string
  ],
  "detail": {
    "StatusCode": "Failed",
    "AutoScalingGroupName": string,
    "ActivityId": string,
    "RequestId": string,
    "StatusMessage": string,
    "EndTime": string,
    "EC2InstanceId": string,
    "StartTime": string,
    "Cause": string
  }
}
