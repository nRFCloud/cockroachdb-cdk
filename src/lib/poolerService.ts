import { Construct, Duration } from '@aws-cdk/core';
import { NetworkLoadBalancer, Protocol } from '@aws-cdk/aws-elasticloadbalancingv2';
import { CockroachCA } from '../resources/cockroachCA';
import { CockroachNodeCertificates } from '../resources/cockroachNodeCertificates';
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  Protocol as ContainerProtocol,
  Secret as ContainerSecret
} from '@aws-cdk/aws-ecs';
import { getContainerPath } from './lib';
import { Secret } from '@aws-cdk/aws-ecs/lib/container-definition';
import { CockroachDBSQLUser } from '../resources/cockroachDbUserCreateProvider';
import { Peer, Port, SecurityGroup } from '@aws-cdk/aws-ec2';
import { ContainerDefinitionWithSecrets } from './containerDefinitionWithSecrets';

export class PoolerService extends Construct {
  private readonly secretMap: {
    [key: string]: Secret;
  };
  private readonly container: ContainerDefinitionWithSecrets;

  constructor(scope: Construct, id: string, options: {
    nlb: NetworkLoadBalancer,
    cluster: Cluster,
    ca: CockroachCA,
    nodeCerts: CockroachNodeCertificates,
    endpoint: string,
    instances: number,
    poolSize: number,
    cpu: number,
    onDemand: boolean,
  }) {
    super(scope, id);

    const {onDemand, nlb, cluster, ca, nodeCerts, endpoint, instances, cpu, poolSize} = options;

    const task = new FargateTaskDefinition(this, 'pooler-task', {
      memoryLimitMiB: 2048,
      cpu,
    })

    this.secretMap = {
      CA_CRT: ContainerSecret.fromSsmParameter(ca.caCrt),
      SERVER_CRT: ContainerSecret.fromSsmParameter(nodeCerts.nodeCrt),
      SERVER_KEY: ContainerSecret.fromSsmParameter(nodeCerts.nodeKey),
    }

    this.container = new ContainerDefinitionWithSecrets(this, 'pooler-container', {
      image: ContainerImage.fromAsset(getContainerPath("cockroach-bouncer")),
      portMappings: [{
        containerPort: 26256,
        protocol: ContainerProtocol.TCP
      }],
      environment: {
        PG_HOST: endpoint,
        PG_PORT: "26257",
        PGB_PORT: "26256",
        PG_POOL_SIZE: poolSize.toString(),
      },
      secrets: this.secretMap,
      logging: LogDriver.awsLogs({streamPrefix: "/cockroach/pool"}),
      stopTimeout: Duration.minutes(2),
      taskDefinition: task
    })

    const sg = new SecurityGroup(this, 'pooler-service-sg', {
      vpc: cluster.vpc,
      allowAllOutbound: true
    })

    sg.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26256));

    const service = new FargateService(this, 'pooler-service', {
      cluster,
      circuitBreaker: {rollback: true},
      assignPublicIp: false,
      desiredCount: instances,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskDefinition: task,
      enableExecuteCommand: true,
      capacityProviderStrategies: [
        onDemand ? {capacityProvider: "FARGATE", weight: 1}
          : {capacityProvider: "FARGATE_SPOT", weight: 1}
      ],
      securityGroups: [sg]
    })

    nlb.addListener('pooler-listener', {
      port: 26256,
      protocol: Protocol.TCP,
    }).addTargets('pooler-target', {
      port: 26256,
      protocol: Protocol.TCP,
      deregistrationDelay: Duration.minutes(0),
      preserveClientIp: false,
      healthCheck: {
        enabled: true,
        port: "26256",
        protocol: Protocol.TCP,
      },
      targets: [
        service.loadBalancerTarget({
          protocol: ContainerProtocol.TCP,
          containerName: this.container.containerName
        })
      ]
    })
  }

  public addUser(user: CockroachDBSQLUser) {
    this.container.addSecret(`PG_USER_${user.username}`, ContainerSecret.fromSecretsManager(user.secret, 'password'))
  }
}
