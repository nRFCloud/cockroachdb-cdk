import { Construct, CustomResource, Duration, Stack } from '@aws-cdk/core';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Provider } from '@aws-cdk/custom-resources';
import { CockroachDBCluster } from '../index';
import { CockroachDBUserSecret } from '../lib/types';
import { getHandlerPath } from '../lib/lib';

export class CockroachDBSQLUser extends Construct {
  public readonly username: string;
  public readonly secret: Secret;
  public readonly database: string;
  public readonly cluster: CockroachDBCluster
  private readonly provider: Provider;

  constructor(scope: Construct, id: string, options: {
    username: string,
    database: string,
    cluster: CockroachDBCluster
  }) {
    super(scope, id);
    this.username = options.username.toLowerCase();
    this.database = options.database;
    this.cluster = options.cluster;

    const lambda = new NodejsFunction(this, 'user-add-lambda', {
      vpc: this.cluster.vpc,
      bundling: {
        minify: true,
        externalModules: ["pg-native", "aws-sdk"]
      },
      timeout: Duration.minutes(1),
      entry: getHandlerPath("cockroachDbUserCreateHandler.js")
    })
    this.cluster.adminSecret.grantRead(lambda)

    this.provider = new Provider(this, 'user-create-provider', {
      onEventHandler: lambda,
    })

    const secretData: Omit<CockroachDBUserSecret, 'password'> = {
      isAdmin: false,
      username: this.username,
      endpoint: this.cluster.endpoint,
      port: 26257,
      options: this.cluster.adminSecret.secretValueFromJson('options').toString()
    }
    // Username used in id to enforce safe naming scheme
    this.secret = new Secret(Stack.of(this), 'user-secret-' + this.username, {
      generateSecretString: {
        generateStringKey: 'password',
        passwordLength: 20,
        includeSpace: false,
        secretStringTemplate: JSON.stringify(secretData)
      }
    });

    this.secret.grantRead(lambda);

    const user = new CustomResource(this, 'user-create-' + this.username, {
      serviceToken: this.provider.serviceToken,
      properties: {
        userSecretId: this.secret.secretArn,
        database: this.database,
        rootUserSecretId: this.cluster.adminSecret.secretArn
      }
    });

    if (this.cluster.vpc) {
      user.node.addDependency(this.cluster.vpc)
    }
  }
}
