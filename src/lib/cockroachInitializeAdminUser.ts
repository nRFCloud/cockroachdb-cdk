import { Construct, CustomResource, Duration, Stack } from '@aws-cdk/core';
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager';
import { CockroachDBUserSecret } from './types';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { IVpc, Vpc } from '@aws-cdk/aws-ec2';
import { CustomResourceProvider } from '@aws-cdk/core/lib/custom-resource-provider/custom-resource-provider';
import { Provider } from '@aws-cdk/custom-resources';
import { CockroachClientCertificates } from '../resources/cockroachClientCertificates';
import { CockroachCA } from '../resources/cockroachCA';
import { getHandlerPath } from './lib';

export class CockroachInitializeAdminUser extends Construct {
  public readonly secret: ISecret

  constructor(scope: Construct, id: string, options: {
    endpoint: string,
    username: string,
    vpc: IVpc,
    rootCerts: CockroachClientCertificates,
    caCerts: CockroachCA
  }) {
    super(scope, id);

    const initAdminHandler = new NodejsFunction(this, 'init-admin-handler', {
      vpc: options.vpc,
      bundling: {
        minify: true,
        externalModules: ["pg-native", "aws-sdk"]
      },
      environment: {
        COCKROACH_CA_CRT_PARAM: options.caCerts.caCrt.parameterName,
        COCKROACH_ROOT_CRT_PARAM: options.rootCerts.clientCrt.parameterName,
        COCKROACH_ROOT_KEY_PARAM: options.rootCerts.clientKey.parameterName
      },
      entry: getHandlerPath("cockroachInitializeAdminUserHandler.js"),
      timeout: Duration.minutes(10),
    })

    const initAdminProvider = new Provider(this, 'init-admin-provider', {
      onEventHandler: initAdminHandler,
    })

    const secretData: Omit<CockroachDBUserSecret, 'password'> = {
      isAdmin: true,
      username: options.username,
      endpoint: options.endpoint,
      port: 26257,
      options: ""
    }
    const secret = new Secret(Stack.of(this), `cockroach-root-user-secret`, {
      generateSecretString: {
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 20,
        includeSpace: false,
        secretStringTemplate: JSON.stringify(secretData)
      }
    });

    secret.grantRead(initAdminHandler)
    options.rootCerts.clientCrt.grantRead(initAdminHandler)
    options.rootCerts.clientKey.grantRead(initAdminHandler)
    options.caCerts.caCrt.grantRead(initAdminHandler)

    new CustomResource(this, 'init-admin', {
      serviceToken: initAdminProvider.serviceToken,
      properties: {
        userSecretId: secret.secretArn
      }
    }).node.addDependency(options.vpc)

    this.secret = secret;
  }

}
