import { Construct, CustomResource, Duration, SecretValue } from '@aws-cdk/core';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { CockroachCLILayer } from '../lib/cockroachCLILayer';
import { join } from 'path';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Provider } from '@aws-cdk/custom-resources';
import { IStringParameter, StringParameter } from '@aws-cdk/aws-ssm';
import { OpenSSLLayer } from '../lib/openSSLLayer';
import { KubernetesManifest } from '@aws-cdk/aws-eks';
import { getHandlerPath } from '../lib/lib';

export interface ICockroachClientCertificates {
  username: string;
  clientCrt: IStringParameter;
  clientKey: IStringParameter;
}

export class CockroachClientCertificates extends Construct implements ICockroachClientCertificates {
  public readonly username: string;
  public readonly clientCrt: IStringParameter;
  public readonly clientKey: IStringParameter;

  constructor(scope: Construct, id: string, options: { caCrtParameter: IStringParameter, caKeyParameter: IStringParameter, username: string }) {
    super(scope, id);
    this.node.addValidation({
      validate: () => /^[a-zA-Z0-9_]+$/g.test(options.username) ? [] : [`Username ${options.username} contains invalid characters`]
    })

    const lambda = new NodejsFunction(this, 'client-cert-lambda', {
      timeout: Duration.minutes(2),
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
      },
      layers: [new OpenSSLLayer(this, 'openssl-layer')],
      entry: getHandlerPath('cockroachCertHandler.js'),
    });

    options.caKeyParameter.grantRead(lambda)
    options.caCrtParameter.grantRead(lambda)

    lambda.addToRolePolicy(new PolicyStatement({
      resources: ["*"],
      actions: [
        "ssm:DeleteParameter",
        "ssm:PutParameter",
        "ssm:DeleteParameters"
      ]
    }))

    const provider = new Provider(this, 'client-cert-provider', {
      onEventHandler: lambda,
    })

    const resource = new CustomResource(this, 'client-cert-resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CockroachClientCertificates',
      properties: {
        username: options.username,
        caCrtParameter: options.caCrtParameter.parameterName,
        caKeyParameter: options.caKeyParameter.parameterName
      }
    })

    resource.node.addDependency(options.caCrtParameter, options.caKeyParameter)

    this.clientCrt = StringParameter.fromSecureStringParameterAttributes(this, 'client-crt', {
      parameterName: resource.getAttString("clientCrtParameter"),
      simpleName: false,
      version: 1
    })
    this.clientKey = StringParameter.fromSecureStringParameterAttributes(this, 'client-key', {
      parameterName: resource.getAttString("clientKeyParameter"),
      simpleName: false,
      version: 1
    })
    this.username = resource.getAttString('username');
  }
}
