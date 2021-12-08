import { Construct, RemovalPolicy } from '@aws-cdk/core';
import { CockroachDBSQLStatement } from './cockroachDbRunSQLProvider';
import { CockroachDBSQLUser } from './cockroachDbUserCreateProvider';
import { CockroachDBCluster } from './index';

export class CockroachDatabase extends Construct {
  public readonly cluster: CockroachDBCluster;
  public readonly database: string;
  private readonly dbInit: CockroachDBSQLStatement;

  constructor(scope: Construct, id: string, options: {
    cluster: CockroachDBCluster
    database: string,
    removalPolicy: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY
  }) {
    super(scope, id)
    this.cluster = options.cluster
    this.database = options.database

    this.dbInit = new CockroachDBSQLStatement(this, 'database-init', {
      database: this.database,
      upQuery: `create database if not exists "${this.database}";`,
      downQuery: options.removalPolicy === RemovalPolicy.DESTROY ? `drop database "${this.database}" cascade;` : 'set application_name to \'test\';',
      cluster: this.cluster
    });
  }

  public addUser(id: string, username: string) {
    const user = new CockroachDBSQLUser(this, id, {
      username,
      database: this.database,
      cluster: this.cluster
    })
    user.node.addDependency(this.dbInit);
    return user;
  }

  public runSql(id: string, upQuery: string, downQuery: string) {
    const statement = new CockroachDBSQLStatement(this, id, {
      cluster: this.cluster,
      database: this.database,
      upQuery,
      downQuery
    })
    statement.node.addDependency(this.dbInit);
    return statement;
  }
}
