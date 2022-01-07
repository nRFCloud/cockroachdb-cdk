import { ISecret } from '@aws-cdk/aws-secretsmanager';
import { Construct, RemovalPolicy } from '@aws-cdk/core';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachDatabase } from './cockroachDatabase';
import { ISubnet, IVpc, Vpc } from '@aws-cdk/aws-ec2';
import { CockroachDBSQLStatement } from './cockroachDbRunSQLProvider';

export interface CockroachDBCluster extends Construct {
  readonly adminSecret: ISecret;
  readonly endpoint: string;
  readonly vpc?: IVpc;
  addDatabase(id: string, database: string, removalPolicy?: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY): CockroachDatabase;
  runSql(id: string, upQuery: string, downQuery: string): CockroachDBSQLStatement;
  automateBackup(bucket: Bucket, path?: string, schedule?: string): CockroachDBSQLStatement;
}

export {CockroachDBServerlessBridge, CockroachDBServerlessConfig} from './cockroachDbServerlessBridge'

export {CockroachDatabase} from './cockroachDatabase'
export {CockroachDBSQLStatement} from './cockroachDbRunSQLProvider'
export {CockroachDBSQLUser} from './cockroachDbUserCreateProvider'
