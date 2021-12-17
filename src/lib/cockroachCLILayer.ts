import { Architecture, Code, LayerVersion, Runtime } from '@aws-cdk/aws-lambda';
import { Construct } from '@aws-cdk/core';
import { join } from 'path';


export class CockroachCLILayer extends LayerVersion {
  private static buildCache: Code;

  constructor(scope: Construct, id: string) {
    if (CockroachCLILayer.buildCache == null) {
      CockroachCLILayer.buildCache = Code.fromDockerBuild(join(__dirname, '..', '..', 'cockroach-cli-bundle'), {
        imagePath: "build",
        platform: 'linux/amd64'
      });
    }
    super(scope, id, {
      compatibleArchitectures: [Architecture.X86_64],
      code: CockroachCLILayer.buildCache
    });
  }
}
