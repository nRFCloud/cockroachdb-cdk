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
