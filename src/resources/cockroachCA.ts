import { Construct, CustomResource, Duration, SecretValue } from '@aws-cdk/core';
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { join } from 'path';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Provider } from '@aws-cdk/custom-resources';
import { CockroachCLILayer } from '../lib/cockroachCLILayer';
import { CockroachNodeCertificates } from './cockroachNodeCertificates';
import { CockroachClientCertificates } from './cockroachClientCertificates';
import { LayerVersion } from '@aws-cdk/aws-lambda';
import { IStringParameter, StringParameter } from '@aws-cdk/aws-ssm'
import { OpenSSLLayer } from '../lib/openSSLLayer';

export class CockroachCA extends Construct {
  public readonly caCrt: IStringParameter;
  public readonly caKey: IStringParameter;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const lambda = new NodejsFunction(this, 'ca-lambda', {
      timeout: Duration.minutes(2),
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
      },
      layers: [new OpenSSLLayer(this, 'cockroach-openssl')],
      entry: join(__dirname, '..', 'handlers', 'cockroachCertHandler.js'),
    });

    lambda.addToRolePolicy(new PolicyStatement({
      resources: ["*"],
      actions: [
        "ssm:DeleteParameter",
        "ssm:PutParameter",
        "ssm:DeleteParameters"
      ]
    }))

    const provider = new Provider(this, 'ca-provider', {
      onEventHandler: lambda,
    })

    const resource = new CustomResource(this, 'ca-resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CockroachCA',
    })

    this.caCrt = StringParameter.fromSecureStringParameterAttributes(this, 'ca-crt-param', {
      parameterName: resource.getAttString("caCrtParameter"),
      simpleName: false,
      version: 1
    })
    this.caKey = StringParameter.fromSecureStringParameterAttributes(this, 'ca-key-param', {
      parameterName: resource.getAttString("caKeyParameter"),
      simpleName: false,
      version: 1
    })
  }

  public createNodeCertificates(id: string, domainNames: string[]) {
    return new CockroachNodeCertificates(this, id, {caKeyParameter: this.caKey, caCrtParameter: this.caCrt, domainNames})
  }

  public createClientCertificates(id: string, username: string) {
    return new CockroachClientCertificates(this, id, {caKeyParameter: this.caKey, caCrtParameter: this.caCrt, username})
  }
}
