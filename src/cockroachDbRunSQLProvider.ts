import { Construct, CustomResource } from '@aws-cdk/core';
import { ISubnet, IVpc, SubnetType } from '@aws-cdk/aws-ec2';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Provider } from '@aws-cdk/custom-resources';
import { IRole } from '@aws-cdk/aws-iam';
import { CockroachDBUserSecret } from './cockroachDBEKSCluster';

export class CockroachDbRunSQLProvider extends Construct {
  private readonly provider: Provider;
  private readonly lambdaRole: IRole;

  constructor(scope: Construct, id: string, private readonly rootSecret: Secret, private readonly endpoint: string, private readonly vpc?: IVpc, private readonly vpcSubnets?: ISubnet[]) {
    super(scope, id);
    const lambda = new NodejsFunction(this, 'run-sql-lambda', {
      vpc,
      vpcSubnets: vpcSubnets ? {subnets: vpcSubnets} : undefined,
      bundling: {
        minify: true,
        externalModules: ["pg-native", "aws-sdk"]
      },
      entry: join(__dirname, "cockroachDbRunSQLHandler.js")
    })
    rootSecret.grantRead(lambda)
    this.lambdaRole = lambda.role
    this.provider = new Provider(this, 'run-sql-provider', {
      vpc,
      onEventHandler: lambda,
    })
  }

  public runSQL(id: string, database: string, upQuery: string, downQuery: string) {
    return new CustomResource(this, id, {
      serviceToken: this.provider.serviceToken,
      properties: {
        database,
        upQuery,
        downQuery,
        rootUserSecretId: this.rootSecret.secretArn
      }
    })
  }
}
