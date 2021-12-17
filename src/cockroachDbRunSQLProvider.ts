import { Construct, CustomResource, Duration } from '@aws-cdk/core';
import { ISubnet, IVpc, SecurityGroup, SubnetType } from '@aws-cdk/aws-ec2';
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { Provider } from '@aws-cdk/custom-resources';
import { IRole } from '@aws-cdk/aws-iam';
import { CockroachDatabase } from './cockroachDatabase';
import { CockroachDBCluster } from './index';

export class CockroachDBSQLStatement extends Construct {
  public readonly database?: string;
  public readonly cluster: CockroachDBCluster
  private readonly provider: Provider;

  constructor(scope: Construct, id: string, options: {
    cluster: CockroachDBCluster,
    database: string,
    upQuery: string,
    downQuery: string,
  }) {
    super(scope, id);

    this.database = options.database;
    this.cluster = options.cluster;


    const lambda = new NodejsFunction(this, 'run-sql-lambda', {
      vpc: this.cluster.vpc,
      bundling: {
        minify: true,
        externalModules: ["pg-native", "aws-sdk"]
      },
      entry: join(__dirname, "cockroachDbRunSQLHandler.js"),
      timeout: Duration.minutes(10)
    })
    this.cluster.rootSecret.grantRead(lambda);

    this.provider = new Provider(this, 'run-sql-provider', {
      vpc: this.cluster.vpc,
      onEventHandler: lambda,
    })

    new CustomResource(this, id, {
      serviceToken: this.provider.serviceToken,
      properties: {
        database: this.database,
        upQuery: options.upQuery,
        downQuery: options.downQuery,
        rootUserSecretId: this.cluster.rootSecret.secretArn
      }
    })
  }
}
