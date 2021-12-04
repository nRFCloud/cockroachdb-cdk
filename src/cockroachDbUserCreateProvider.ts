import { Construct, CustomResource } from '@aws-cdk/core';
import { ISubnet, IVpc, SubnetType } from '@aws-cdk/aws-ec2';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Provider } from '@aws-cdk/custom-resources';
import { IRole } from '@aws-cdk/aws-iam';
import { CockroachDBUserSecret } from './cockroachDBEKSCluster';

export class CockroachDbUserCreateProvider extends Construct {
  private readonly provider: Provider;
  private readonly lambdaRole: IRole;

  constructor(scope: Construct, id: string, private readonly rootSecret: Secret, private readonly endpoint: string, private readonly vpc?: IVpc, private readonly vpcSubnets?: ISubnet[]) {
    super(scope, id);
    const lambda = new NodejsFunction(this, 'user-add-lambda', {
      vpc,
      vpcSubnets: vpcSubnets ? {subnets: vpcSubnets} : undefined,
      bundling: {
        minify: true,
        externalModules: ["pg-native", "aws-sdk"]
      },
      entry: join(__dirname, "cockroachDbUserCreateHandler.js")
    })
    rootSecret.grantRead(lambda)
    this.lambdaRole = lambda.role
    this.provider = new Provider(this, 'user-create-provider', {
      vpc,
      onEventHandler: lambda,
    })
  }

  public addUser(username: string, database: string) {
    const usernameLower = username.toLowerCase();
    const secretData: Omit<CockroachDBUserSecret, 'password'> = {
      isAdmin: false,
      username: usernameLower,
      endpoint: this.endpoint,
      port: 26257
    }
    // Username used in id to enforce safe naming scheme
    const secret = new Secret(this, 'user-secret-' + usernameLower, {
      generateSecretString: {
        generateStringKey: 'password',
        passwordLength: 20,
        includeSpace: false,
        secretStringTemplate: JSON.stringify(secretData)
      }
    });

    new CustomResource(this, 'user-create-' + usernameLower, {
      serviceToken: this.provider.serviceToken,
      properties: {
        userSecretId: secret.secretArn,
        database,
        rootUserSecretId: this.rootSecret.secretArn
      }
    }).node.addDependency(secret, secret.grantRead(this.lambdaRole))

    return secret;
  }
}
