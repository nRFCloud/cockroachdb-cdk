import { Construct, Duration } from '@aws-cdk/core';
import {
  Cluster,
  ContainerImage,
  DeploymentControllerType,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  Protocol
} from '@aws-cdk/aws-ecs'
import { Peer, Port, SecurityGroup, Vpc } from '@aws-cdk/aws-ec2';
import { NamespaceType } from '@aws-cdk/aws-servicediscovery';
import { NetworkLoadBalancer, Protocol as ELBProtocol } from '@aws-cdk/aws-elasticloadbalancingv2'

export class CockroachDBECSFargate extends Construct {
  constructor(stack: Construct, id: string, options: CockroachDBECSFargateOptions) {
    super(stack, id);

    const optionsWithDefaults = {
      ...options,
      ...CockroachDBECSFargateOptionsDefaults
    }

    const cluster = new Cluster(this, 'cockroach-cluster', {
        vpc: optionsWithDefaults.vpc,
        enableFargateCapacityProviders: true,
        defaultCloudMapNamespace: {
          name: "db.crdb.com",
          type: NamespaceType.DNS_PRIVATE
        }
      }
    )

    const task = new FargateTaskDefinition(this, 'cockroach-task', {
      cpu: 4096,
      memoryLimitMiB: 16384,
      volumes: [
        {
          name: "cockroach-storage",
          host: {
            sourcePath: "/"
          }
        }
      ]
    })

    task.addContainer('cockroachdb', {
      cpu: 4096,
      stopTimeout: Duration.minutes(2),
      containerName: "cockroachdb-container",
      logging: LogDriver.awsLogs({streamPrefix: "cockroach"}),
      memoryLimitMiB: 16384,
      portMappings: [{containerPort: 8080, protocol: Protocol.TCP, hostPort: 8080}, {containerPort: 26257, protocol: Protocol.TCP, hostPort: 26257}, {containerPort: 26258, protocol: Protocol.TCP, hostPort: 26258}],
      healthCheck: {
        command: ["curl","--fail", "http://localhost:8080/health?ready=1"],
      },
      image: ContainerImage.fromRegistry('cockroachdb/cockroach:v21.2.0'),
      command: [
        "start",
        "--cluster-name=cockroach",
        "--insecure",
        "--join=cockroach.db.crdb.com,cockroach.db.crdb.com,cockroach.db.crdb.com,cockroach.db.crdb.com",
        "--logtostderr=INFO",
        "--cache=.25",
      ],
    })

    const serviceSG = new SecurityGroup(this, 'cockroach-service-sg', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
    })

    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26257), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(8080), 'cockroach-sql-access')

    const service = new FargateService(this, 'cockroach-service', {
      cluster,
      serviceName: "cockroach-service",
      securityGroups: [serviceSG],
      minHealthyPercent: Math.trunc(((optionsWithDefaults.nodes - 1)/ optionsWithDefaults.nodes) * 100),
      maxHealthyPercent: 100,
      cloudMapOptions: {
        dnsTtl: Duration.seconds(1),
        name: "cockroach",
      },
      deploymentController: {
        type: DeploymentControllerType.ECS,

      },
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 100,
        },
        {
          capacityProvider: 'FARGATE',
          weight: 0,
        },
      ],
      desiredCount: optionsWithDefaults.nodes,
      taskDefinition: task,
      healthCheckGracePeriod: Duration.days(900),
      enableExecuteCommand: true,
    })

    const nlb = new NetworkLoadBalancer(this, 'cockroach-lb', {
      vpc: cluster.vpc,
      crossZoneEnabled: true,
      internetFacing: true,
    })

    nlb.addListener('sql-listener', {
      port: 26257,
      protocol: ELBProtocol.TCP
    }).addTargets('cockroach-sql-target', {
      targets: [service.loadBalancerTarget({
        containerName: "cockroachdb-container",
        containerPort: 26257,
      })],
      healthCheck: {
        enabled: true,
        port: "8080",
        protocol: ELBProtocol.HTTP,
        path: "/health?ready=1",
      },
      port: 26257,
    })

    nlb.addListener('console-listener', {
      port: 8080,
      protocol: ELBProtocol.TCP
    }).addTargets('cockroach-console-target', {
      targets: [service.loadBalancerTarget({
        containerName: "cockroachdb-container",
        containerPort: 8080,
      })],
      healthCheck: {
        enabled: true,
        port: "8080",
        protocol: ELBProtocol.HTTP,
        path: "/health?ready=1",
      },
      port: 8080,
    })

  }
}

export interface CockroachDBECSFargateOptions {
  vpc?: Vpc,
  nodes?: number
}

const CockroachDBECSFargateOptionsDefaults: CockroachDBECSFargateOptions = {
  nodes: 3
}
