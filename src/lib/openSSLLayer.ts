import { Architecture, Code, LayerVersion, Runtime } from '@aws-cdk/aws-lambda';
import { Construct } from '@aws-cdk/core';
import { join } from 'path';

export class OpenSSLLayer extends LayerVersion {
  private static buildCache: Code;

  constructor(scope: Construct, id: string) {
    if (OpenSSLLayer.buildCache == null) {
      OpenSSLLayer.buildCache = Code.fromAsset(join(__dirname, '..', '..', 'vendored', 'openssl'));
    }
    super(scope, id, {
      compatibleArchitectures: [Architecture.X86_64],
      code: OpenSSLLayer.buildCache
    });
  }
}
