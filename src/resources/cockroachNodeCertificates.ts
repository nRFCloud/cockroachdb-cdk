import { Construct, CustomResource, Duration, SecretValue } from '@aws-cdk/core';
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { CockroachCLILayer } from '../lib/cockroachCLILayer';
import { join } from 'path';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Provider } from '@aws-cdk/custom-resources';
import { IStringParameter, StringParameter } from '@aws-cdk/aws-ssm';
import { OpenSSLLayer } from '../lib/openSSLLayer';
import { getHandlerPath } from '../lib/lib';

export class CockroachNodeCertificates extends Construct {
  public readonly nodeCrt: IStringParameter;
  public readonly nodeKey: IStringParameter;

  constructor(scope: Construct, id: string, options: { caCrtParameter: IStringParameter, caKeyParameter: IStringParameter, domainNames: string[] }) {
    super(scope, id);

    const lambda = new NodejsFunction(this, 'node-cert-lambda', {
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

    const provider = new Provider(this, 'node-cert-provider', {
      onEventHandler: lambda,
    })

    const resource = new CustomResource(this, 'node-cert-resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CockroachNodeCertificates',
      properties: {
        domainNames: options.domainNames,
        caCrtParameter: options.caCrtParameter.parameterName,
        caKeyParameter: options.caKeyParameter.parameterName
      }
    })

    resource.node.addDependency(options.caCrtParameter, options.caKeyParameter)

    this.nodeCrt = StringParameter.fromSecureStringParameterAttributes(this, 'node-crt', {
      parameterName: resource.getAttString("nodeCrtParameter"),
      version: 1,
      simpleName: false,
    })
    this.nodeKey = StringParameter.fromSecureStringParameterAttributes(this, 'node-key', {
      parameterName: resource.getAttString("nodeKeyParameter"),
      version: 1,
      simpleName: false,
    })
  }

}
