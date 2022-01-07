import { Construct, RemovalPolicy } from '@aws-cdk/core';
import { ISecret } from '@aws-cdk/aws-secretsmanager';
import { CfnAccessKey, User } from '@aws-cdk/aws-iam';
import { CockroachDBCluster } from './index';
import { CockroachDBSQLStatement } from './cockroachDbRunSQLProvider';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachDatabase } from './cockroachDatabase';

export class CockroachDBServerlessBridge extends Construct implements CockroachDBCluster {
  public readonly adminSecret: ISecret;
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, private readonly options: CockroachDBServerlessConfig) {
    super(scope, id);

    this.adminSecret = options.rootSecret;
    this.endpoint = this.adminSecret.secretValueFromJson('endpoint').toString()
  }

  public addDatabase(id: string, database: string, removalPolicy: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY = RemovalPolicy.RETAIN): CockroachDatabase {
    return new CockroachDatabase(this, id, {
      cluster: this,
      database,
      removalPolicy
    })
  }

  public automateBackup(bucket: Bucket, path?: string, schedule?: string): CockroachDBSQLStatement {
    const backupUser = new User(this, 'backup-user')
    bucket.grantReadWrite(backupUser);
    const backupUserCredentials = new CfnAccessKey(this, 'backup-user-credentials', {
      userName: backupUser.userName,
    })
    return this.runSql('automatic-backup',
      `create schedule dailybackup for backup into 's3://${bucket.bucketName}/${path}?AWS_ACCESS_KEY_ID=${backupUserCredentials.ref}&AWS_SECRET_ACCESS_KEY=${backupUserCredentials.attrSecretAccessKey}'
with detached RECURRING '@daily'
full backup always 
with schedule options first_run = 'now';`,
      `drop schedules select id from [show schedules] where label = 'dailybackup';`)
  }

  public runSql(id: string, upQuery: string, downQuery: string): CockroachDBSQLStatement {
    return new CockroachDBSQLStatement(this, id, {
      database: 'defaultdb', cluster: this,
      upQuery, downQuery
    })
  }
}

export interface CockroachDBServerlessConfig {
  rootSecret: ISecret,
}
