import {
  ContainerDefinition, Secret as ContainerSecret
} from '@aws-cdk/aws-ecs';

export class ContainerDefinitionWithSecrets extends ContainerDefinition {
  constructor(...args: ConstructorParameters<typeof ContainerDefinition>) {
    super(...args);
  }

  public addSecret(key: string, secret:ContainerSecret ) {
    if (secret.hasField) {
      (this as any).referencesSecretJsonField = true;
    }
    secret.grantRead(this.taskDefinition.obtainExecutionRole());
    (this as any).secrets.push({
      name: key,
      valueFrom: secret.arn
    })
  }
}
