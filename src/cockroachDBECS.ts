import { Construct, Duration, Stack } from '@aws-cdk/core';
import {
  AsgCapacityProvider,
  BottleRocketImage,
  CfnTaskDefinition,
  Cluster,
  ContainerImage,
  DeploymentControllerType,
  Ec2TaskDefinition,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  MachineImageType,
  NetworkMode, PlacementConstraint,
  Protocol,
  Secret as ContainerSecret,
  TaskDefinition,
  UlimitName,
} from '@aws-cdk/aws-ecs'
import {
  CfnLaunchTemplate,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  Vpc
} from '@aws-cdk/aws-ec2';
import { DnsRecordType, NamespaceType } from '@aws-cdk/aws-servicediscovery';
import { NetworkLoadBalancer, Protocol as ELBProtocol } from '@aws-cdk/aws-elasticloadbalancingv2'
import { join } from 'path';
import { CockroachCA } from './resources/cockroachCA';
import { CockroachNodeCertificates } from './resources/cockroachNodeCertificates';
import { createHash, randomBytes } from 'crypto'
import { RunTask } from 'cdk-fargate-run-task'
import { CockroachClientCertificates } from './resources/cockroachClientCertificates';
import { ParameterTier, StringParameter } from '@aws-cdk/aws-ssm';
import { toYAML } from 'aws-cdk/lib/serialize';
import { Effect, ManagedPolicy, Policy, PolicyStatement } from '@aws-cdk/aws-iam';
import { Rule } from '@aws-cdk/aws-events'
import { CloudWatchLogGroup } from '@aws-cdk/aws-events-targets'
import { LogGroup } from '@aws-cdk/aws-logs'
import { AutoScalingGroup, CfnAutoScalingGroup, CfnLaunchConfiguration, UpdatePolicy } from '@aws-cdk/aws-autoscaling';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';

export class CockroachDBECS extends Construct {
  private readonly internalBaseDomain = 'cockroach.db.crdb.com'
  private readonly internalDomainPrefix: string;
  private readonly internalDomain: string;
  private readonly options: CockroachDBECSFargateOptionsWithDefaults;
  private readonly cluster: Cluster;
  private readonly vpc: IVpc;
  public readonly ca = new CockroachCA(this, 'cockroach-ca-certs')
  private readonly nodeCerts: CockroachNodeCertificates;
  public readonly rootCerts: CockroachClientCertificates;
  private readonly taskFamily: string;
  public readonly endpoint: string;

  private addValidation(options: CockroachDBECSFargateOptionsWithDefaults) {
    this.node.addValidation({
      validate: () => {
        const errors = [];
        if (options.nodes < 3) {
          errors.push('CockroachDB requires a minimum of 3 nodes')
        }
        if (options.storagePerNode < 20) {
          errors.push('Nodes must have at leaste 20GB of storage')
        }
        return errors;
      }
    })
  }

  constructor(stack: Construct, id: string, options: CockroachDBECSFargateOptions) {
    super(stack, id);
    this.options = {
      ...CockroachDBECSFargateOptionsDefaults,
      ...options,
    }

    this.addValidation(this.options)
    this.rootCerts = this.ca.createClientCertificates(this.optionalUniqueCertId('cockroach-root-certs'), 'root')
    this.internalDomainPrefix = createHash('sha1').update(this.node.id).digest().toString('hex').substring(0, 8)
    this.internalDomain = `${this.internalDomainPrefix}.${this.internalBaseDomain}`
    this.taskFamily = `cockroach-task-${this.internalDomainPrefix}`


    this.cluster = new Cluster(this, 'cockroach-cluster', {
        vpc: this.options.vpc,
        containerInsights: this.options.enhancedMetrics,
        defaultCloudMapNamespace: {
          name: this.internalBaseDomain,
          type: NamespaceType.DNS_PRIVATE
        },
      }
    )

    this.addEc2SpotCapacity(this.cluster, this.options)
    const nlb = new NetworkLoadBalancer(this, 'cockroach-lb', {
      vpc: this.cluster.vpc,
      crossZoneEnabled: true,
      internetFacing: true,
    })

    this.nodeCerts = this.ca.createNodeCertificates(this.optionalUniqueCertId('cockroach-node-certs'), [
      `*.${this.internalDomain}`,
      '*.ec2.internal',
      'localhost',
      nlb.loadBalancerDnsName
    ])

    this.vpc = this.cluster.vpc;

    const task = this.configureTask(this.ca, this.nodeCerts, this.rootCerts);
    const init = this.runInitTask(this.cluster, this.ca, this.rootCerts);
    const service = this.configureService(this.cluster, task);
    this.configurePrometheusMetrics(this.cluster)
    // this.handleSpotInterruption(this.cluster, service, nlb)
    service.node.addDependency(init);
    this.configureLoadBalancerTargets(nlb, service, this.options)
    this.endpoint = nlb.loadBalancerDnsName;
  }


  private configurePrometheusMetrics(cluster: Cluster) {
    const cwAgentConfigContent = this.generateCWAgentConfig(cluster);
    const prometheusConfig = new StringParameter(this, 'cockroach-cw-agent-prometheus-config-param', {
      tier: ParameterTier.INTELLIGENT_TIERING,
      stringValue: toYAML({
        global: {
          scrape_interval: '1m',
          scrape_timeout: '10s'
        },
        scrape_configs: [
          {
            job_name: 'cockroachdb',
            sample_limit: 10000,
            file_sd_configs: [
              {
                files: [cwAgentConfigContent.logs.metrics_collected.prometheus.ecs_service_discovery.sd_result_file]
              }
            ]
          }
        ]
      })
    })
    const cwAgentConfig = new StringParameter(this, 'cockroach-cw-agent-config-param', {
      tier: ParameterTier.INTELLIGENT_TIERING,
      stringValue: JSON.stringify(cwAgentConfigContent)
    })

    const cwAgentTask = new FargateTaskDefinition(this, 'cockroach-cw-agent-task', {
      cpu: 256,
      memoryLimitMiB: 512,
      family: `cockroach-cw-agent-task-${this.internalDomainPrefix}`
    })
    const taskExecutionRole = cwAgentTask.obtainExecutionRole();
    taskExecutionRole.addManagedPolicy(ManagedPolicy.fromManagedPolicyArn(this, 'cockroach-cw-agent-ecs-task-execution-policy',
      'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'))
    taskExecutionRole.addManagedPolicy(ManagedPolicy.fromManagedPolicyArn(this, 'cockroach-cw-agent-execution-server-policy',
      'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'))

    const taskRole = cwAgentTask.taskRole;
    taskRole.addManagedPolicy(ManagedPolicy.fromManagedPolicyArn(this, 'cockroach-cw-agent-server-policy',
      'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'))
    taskRole.attachInlinePolicy(new Policy(this, 'cockroach-cw-agent-ecs-discovery-policy', {
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "ecs:DescribeTasks",
            "ecs:ListTasks",
            "ecs:DescribeContainerInstances",
            "ecs:DescribeServices",
            "ecs:ListServices"
          ],
          resources: ["*"],
          conditions: {
            ArnEquals: {
              "ecs:cluster": cluster.clusterArn
            }
          }
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "ec2:DescribeInstances",
            "ecs:DescribeTaskDefinition"
          ],
          resources: ["*"]
        })
      ]
    }));

    cwAgentTask.addContainer('cockroach-cw-agent-container', {
      essential: true,
      logging: LogDriver.awsLogs({streamPrefix: "/ecs/ecs-cwagent-prometheus"}),
      image: ContainerImage.fromRegistry('public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest'),
      secrets: {
        PROMETHEUS_CONFIG_CONTENT: ContainerSecret.fromSsmParameter(prometheusConfig),
        CW_CONFIG_CONTENT: ContainerSecret.fromSsmParameter(cwAgentConfig)
      }
    });

    // use ARM64 nodes to reduce on demand cost
    if (this.options.onDemandMetrics) {
      (cwAgentTask.node.defaultChild as CfnTaskDefinition).addPropertyOverride('RuntimePlatform', {
        cpuArchitecture: "ARM64"
      })
    }

    const cwAgentService = new FargateService(this, 'cockroach-cw-agent-service', {
      cluster,
      serviceName: `cockroach-cw-agent-service-${this.internalDomainPrefix}`,
      taskDefinition: cwAgentTask,
      capacityProviderStrategies: [
        this.options.onDemandMetrics ?
          {capacityProvider: "FARGATE", weight: 1}
          : {capacityProvider: "FARGATE_SPOT", weight: 1}
      ],
      minHealthyPercent: 100,
      desiredCount: 1,
      circuitBreaker: {
        rollback: false,
      },
      enableExecuteCommand: true,
    });

    return cwAgentService;
  }

  /**
   * Spot interruption do not automatically deregister the instance from the load balancer.
   * This leads to delay in draining that can cause connection errors.
   */
  private handleSpotInterruption(cluster: Cluster, service: FargateService, lb: NetworkLoadBalancer) {
    const event = new Rule(this, 'cockroach-deregistration-rule', {
      enabled: true,
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          desiredStatus: ["STOPPED"],
          clusterArn: [cluster.clusterArn],
          group: [`service:${this.taskFamily}`],
        }
      },
      targets: [
        new CloudWatchLogGroup(new LogGroup(this, 'ecs-task-stop'))
      ]
    })
  }

  private configureTask(caCerts: CockroachCA, nodeCerts: CockroachNodeCertificates, rootCerts: CockroachClientCertificates): FargateTaskDefinition {
    const task = new FargateTaskDefinition(this, 'cockroach-task', {
      cpu: this.options.cpuAllocation,
      memoryLimitMiB: this.options.memoryAllocation,
      ephemeralStorageGiB: this.options.storagePerNode,
      family: this.taskFamily
    })

    const container = task.addContainer('cockroachdb', {
      cpu: this.options.cpuAllocation,
      stopTimeout: Duration.minutes(2),
      containerName: "cockroachdb-container",
      logging: LogDriver.awsLogs({streamPrefix: "cockroach"}),
      memoryLimitMiB: this.options.memoryAllocation,
      portMappings: [{containerPort: 8080, protocol: Protocol.TCP, hostPort: 8080}, {
        containerPort: 26257,
        protocol: Protocol.TCP,
        hostPort: 26257
      }, {containerPort: 26258, protocol: Protocol.TCP, hostPort: 26258}],
      healthCheck: {
        command: ["curl", "--fail", "http://localhost:8080/health?ready=1"],
        startPeriod: Duration.seconds(300),
      },
      secrets: {
        COCKROACH_CA_CRT: ContainerSecret.fromSsmParameter(caCerts.caCrt),
        COCKROACH_NODE_CRT: ContainerSecret.fromSsmParameter(nodeCerts.nodeCrt),
        COCKROACH_NODE_KEY: ContainerSecret.fromSsmParameter(nodeCerts.nodeKey),
        COCKROACH_ROOT_CRT: ContainerSecret.fromSsmParameter(rootCerts.clientCrt),
        COCKROACH_ROOT_KEY: ContainerSecret.fromSsmParameter(rootCerts.clientKey)
      },
      environment: {
        COCKROACH_SKIP_KEY_PERMISSION_CHECK: "true",
        COCKROACH_DOMAIN: this.internalDomain,
        AWS_REGION: Stack.of(this).region,
        GOMAXPROCS: Math.floor(this.options.cpuAllocation / 1024).toString(),
      },
      image: ContainerImage.fromAsset(join(__dirname, '..', 'cockroach-bootstraped'), {
        buildArgs: {
          COCKROACH_IMAGE: this.options.cockroachImage
        }
      }),
      command: [
        "start",
        "--cluster-name=cockroach",
        "--logtostderr=INFO",
        "--cache=.25",
        "--max-sql-memory=.25",
        "--http-port=8080",
        "--sql-addr=:26257",
        "--listen-addr=:26258",
      ],
    })
    container.addUlimits({name: UlimitName.NOFILE, softLimit: 15000, hardLimit: 30000},)

    return task;
  }

  private configureTaskEc2(caCerts: CockroachCA, nodeCerts: CockroachNodeCertificates, rootCerts: CockroachClientCertificates): FargateTaskDefinition {
    const bottlerocketMountPoint = "/.bottlerocket/rootfs/mnt";
    const volumeConfigs = [...new Array(4)].map((_, idx) => (
      {
        name: "drive" + idx,
        host: {
          sourcePath: join(bottlerocketMountPoint, "drive" + idx)
        }
      }
    ));

    const task = new Ec2TaskDefinition(this, 'cockroach-task', {
      family: this.taskFamily,
      // We only run a single instance per node, so host makes the most of our network performance
      networkMode: NetworkMode.HOST,
      volumes: volumeConfigs,
      placementConstraints: [PlacementConstraint.distinctInstances()],
    })

    const container = task.addContainer('cockroachdb', {
      cpu: this.options.cpuAllocation,
      stopTimeout: Duration.minutes(10),
      containerName: "cockroachdb-container",
      logging: LogDriver.awsLogs({streamPrefix: "cockroach"}),
      memoryReservationMiB: 4096,
      portMappings: [{containerPort: 8080, protocol: Protocol.TCP, hostPort: 8080}, {
        containerPort: 26257,
        protocol: Protocol.TCP,
        hostPort: 26257
      }, {containerPort: 26258, protocol: Protocol.TCP, hostPort: 26258}],
      healthCheck: {
        command: ["curl", "--fail", "http://localhost:8080/health?ready=1"],
        startPeriod: Duration.seconds(300),
      },
      secrets: {
        COCKROACH_CA_CRT: ContainerSecret.fromSsmParameter(caCerts.caCrt),
        COCKROACH_NODE_CRT: ContainerSecret.fromSsmParameter(nodeCerts.nodeCrt),
        COCKROACH_NODE_KEY: ContainerSecret.fromSsmParameter(nodeCerts.nodeKey),
        COCKROACH_ROOT_CRT: ContainerSecret.fromSsmParameter(rootCerts.clientCrt),
        COCKROACH_ROOT_KEY: ContainerSecret.fromSsmParameter(rootCerts.clientKey)
      },
      environment: {
        COCKROACH_SKIP_KEY_PERMISSION_CHECK: "true",
        COCKROACH_DOMAIN: this.internalDomain,
        AWS_REGION: Stack.of(this).region,
        GOMAXPROCS: Math.floor(this.options.cpuAllocation / 1024).toString(),
      },
      image: ContainerImage.fromAsset(join(__dirname, '..', 'cockroach-bootstraped'), {
        buildArgs: {
          COCKROACH_IMAGE: this.options.cockroachImage
        }
      }),
      command: [
        "start",
        "--cluster-name=cockroach",
        "--logtostderr=INFO",
        "--cache=.25",
        "--max-sql-memory=.25",
        "--http-port=8080",
        "--sql-addr=:26257",
        "--listen-addr=:26258",
      ],
    })
    container.addUlimits({name: UlimitName.NOFILE, softLimit: 15000, hardLimit: 30000},)

    return task;
  }

  private runInitTask(cluster: Cluster, caCerts: CockroachCA, rootCerts: CockroachClientCertificates) {
    const task = new FargateTaskDefinition(this, 'cockroach-init-task', {
      cpu: 256,
      memoryLimitMiB: 512,
    })

    task.addContainer('cockroach-init-container', {
      containerName: "cockroach-init",
      logging: LogDriver.awsLogs({streamPrefix: 'cockroach-init'}),
      image: ContainerImage.fromAsset(join(__dirname, '..', 'cockroach-initializer'), {
        buildArgs: {
          COCKROACH_IMAGE: this.options.cockroachImage
        },
      }),
      secrets: {
        COCKROACH_CA_CRT: ContainerSecret.fromSsmParameter(caCerts.caCrt),
        COCKROACH_ROOT_CRT: ContainerSecret.fromSsmParameter(rootCerts.clientCrt),
        COCKROACH_ROOT_KEY: ContainerSecret.fromSsmParameter(rootCerts.clientKey)
      },
      environment: {
        COCKROACH_SKIP_KEY_PERMISSION_CHECK: "true",
        COCKROACH_DOMAIN: this.internalDomain
      },
      command: ["--cluster-name=cockroach"],
    })

    const run = new RunTask(this, 'cockroach-init-run', {
      cluster,
      vpc: cluster.vpc,
      task,
    })

    run.node.addDependency(task);
    return run;
  }

  private configureService(cluster: Cluster, task: TaskDefinition) {
    const serviceSG = new SecurityGroup(this, 'cockroach-service-sg', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
    })

    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26257), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26258), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(8080), 'cockroach-sql-access')

    // Replace one third of the nodes at a time
    // const replacementBudget = Math.floor(this.options.nodes / 3)
    // const maxHealthy = Math.min(Math.ceil(((this.options.nodes + replacementBudget) / this.options.nodes) * 100), 200)

    return new FargateService(this, 'cockroach-service', {
      cluster,
      serviceName: "cockroach-service",
      securityGroups: [serviceSG],
      minHealthyPercent: 100,
      // Replace one third of the nodes at a time
      maxHealthyPercent: 134,
      cloudMapOptions: {
        dnsTtl: Duration.seconds(1),
        name: this.internalDomainPrefix,
        dnsRecordType: DnsRecordType.SRV,
        containerPort: 26258
      },
      deploymentController: {
        type: DeploymentControllerType.ECS,
      },
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 100
        },
        {
          capacityProvider: "FARGATE",
          weight: 0,
          base: this.options.onDemandNodes,
        }
      ],
      desiredCount: this.options.nodes,
      taskDefinition: task,
      healthCheckGracePeriod: Duration.minutes(60),
      enableExecuteCommand: true,
      circuitBreaker: {
        rollback: true,
      },
    })
  }

  private addEc2SpotCapacity(cluster: Cluster, options: CockroachDBECSFargateOptionsWithDefaults) {
    const asg = new AutoScalingGroup(this, 'cockroach-asg', {
      allowAllOutbound: true,
      machineImage: new BottleRocketImage(),
      updatePolicy: UpdatePolicy.rollingUpdate(),
      instanceType: InstanceType.of(InstanceClass.C5AD, InstanceSize.XLARGE),
      vpc: cluster.vpc,
      minCapacity: options.nodes,
      maxCapacity: options.nodes * 2,
    })

    asg.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))

    const ephemeralBootstrapImage = new DockerImageAsset(this, 'ephemeral-bootstrap-image', {
      directory: join(__dirname, '..', 'ephemeral-bootstrap'),
    })

    ephemeralBootstrapImage.repository.grantPull(asg.role)

    cluster.addAsgCapacityProvider(new AsgCapacityProvider(this, 'cockroach-asg-provider', {
      autoScalingGroup: asg,
      spotInstanceDraining: true,
      enableManagedScaling: true,
      machineImageType: MachineImageType.BOTTLEROCKET,
      enableManagedTerminationProtection: true,
    }))

    asg.addUserData(
      '[settings.bootstrap-containers.setup-ephemeral-disks]',
      'mode = "always"',
      'essential = false',
      `source = "${ephemeralBootstrapImage.imageUri}"`,
    )

    // Dirty hack to use launch templates

    const cfnAsg = asg.node.defaultChild as CfnAutoScalingGroup;

    const cfnLaunchConfig = asg.node.tryFindChild('LaunchConfig') as CfnLaunchConfiguration;
    asg.node.tryRemoveChild('LaunchConfig');
    cfnAsg.launchConfigurationName = undefined;

    // const cfnLaunchTemplate = launchTemplate.node.defaultChild as CfnLaunchTemplate;
    const cfnLaunchTemplate = new CfnLaunchTemplate(this, 'cockroach-launch-template', {
      launchTemplateData: {
        userData: cfnLaunchConfig.userData,
        securityGroupIds: cfnLaunchConfig.securityGroups,
        iamInstanceProfile: {name: cfnLaunchConfig.iamInstanceProfile},
        instanceMarketOptions: {},
        keyName: cfnLaunchConfig.keyName,
        imageId: new BottleRocketImage().getImage(this).imageId,
      }
    })

    cfnAsg.mixedInstancesPolicy = {
      instancesDistribution: {
        spotAllocationStrategy: 'capacity-optimized',
      },
      launchTemplate: {
        launchTemplateSpecification: {
          launchTemplateId: cfnLaunchTemplate.ref,
          version: cfnLaunchTemplate.attrLatestVersionNumber
        },
        overrides: [
          {
            instanceRequirements: {
              instanceGenerations: ["current"],
              vCpuCount: {
                max: 4,
                min: 4
              },
              memoryGiBPerVCpu: {
                min: 4,
                max: 8
              },
              memoryMiB: {
                min: 8 * 1024,
                max: 32 * 1024
              },
              acceleratorCount: {max: 0},
              totalLocalStorageGb: {min: 90, max: 500},
              localStorageTypes: ["ssd"],
              cpuManufacturers: ["intel", 'amd'],
            }
          }
        ]
      }
    }
  }

  private configureLoadBalancerTargets(nlb: NetworkLoadBalancer, service: FargateService, options: CockroachDBECSFargateOptions) {
    nlb.addListener('sql-listener', {
      port: 26257,
      protocol: ELBProtocol.TCP
    }).addTargets('cockroach-sql-target', {
      targets: [service.loadBalancerTarget({
        containerName: "cockroachdb-container",
        containerPort: 26257,
      })],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        enabled: true,
        port: "8080",
        protocol: ELBProtocol.HTTP,
        path: "/health?ready=1",
        interval: Duration.seconds(10),
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
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
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        enabled: true,
        port: "8080",
        protocol: ELBProtocol.HTTP,
        path: "/health?ready=1",
        interval: Duration.seconds(10),
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
      },
      port: 8080,
    })
  }

  private optionalUniqueCertId(id: string) {
    return this.options.rotateCertsOnDeployment ?
      `${id}-${randomBytes(3).toString('hex')}` :
      id
  }

  private generateCWAgentConfig(cluster: Cluster) {
    return {
      logs: {
        metrics_collected: {
          prometheus: {
            "prometheus_config_path": "env:PROMETHEUS_CONFIG_CONTENT",
            "ecs_service_discovery": {
              "sd_frequency": "1m",
              "sd_result_file": "/tmp/cwagent_ecs_auto_sd.yaml",
              "task_definition_list": [
                {
                  "sd_job_name": "cockroachdb",
                  "sd_metrics_ports": "8080",
                  "sd_task_definition_arn_pattern": `.*:task-definition/${this.taskFamily}:[0-9]+`, //cockroachTask.taskDefinitionArn,
                  "sd_metrics_path": "/_status/vars"
                }
              ]
            },
            emf_processor: {}
          },
        }
      },
      force_flush_interval: 5,
      agent: {
        debug: true
      }
    } as const;
  }
}

export interface CockroachDBECSFargateOptions {
  /**
   * Number of nodes in the cluster. Minimum of 3.
   * @default 3
   */
  nodes?: number
  /**
   * VPC placement. Must include private subnets with internet access.
   */
  vpc?: Vpc,
  /**
   * Storage in gigabytes provisioned on each node. Valid values between 20 and 200
   * @default 200
   */
  storagePerNode?: number
  /**
   * CockroachDB docker image to use
   * @default cockroachdb/cockroach:v21.2.2
   */
  cockroachImage?: string;
  /**
   * CPU units to allocate to each node. See Fargate documentation for valid values
   * @default 4096
   */
  cpuAllocation?: number;
  /**
   * Memory in megabytes to allocate to each node. See Fargate documentation for valid values
   * @default 16384
   */
  memoryAllocation?: number;
  /**
   * Rotate node and root certificates on every deployment. Will trigger a rolling update every time, so be ready to wait.
   * Turning this on/off also triggers a deployment
   * @default false
   */
  rotateCertsOnDeployment?: boolean;
  /**
   * Enables enhanced metrics for the cluster. Extra charges will apply for additional custom metrics, and a (small) additional container to run the cloudwatch agent.
   */
  enhancedMetrics?: boolean
  /**
   * Run a minimum number of on demand instances. Recommend at least 2 for high availability
   * @default 2
   */
  onDemandNodes?: number;
  /**
   * Run metrics agent with on demand capacity. This is more expensive, but will guarantee metric availability
   */
  onDemandMetrics?: boolean;
}

type CockroachDBECSFargateOptionsWithDefaults =
  CockroachDBECSFargateOptions
  & typeof CockroachDBECSFargateOptionsDefaults;

const CockroachDBECSFargateOptionsDefaults = {
  nodes: 3,
  storagePerNode: 200,
  cockroachImage: "cockroachdb/cockroach:v21.2.3",
  cpuAllocation: 4096,
  memoryAllocation: 16384,
  rotateCertsOnDeployment: false,
  enhancedMetrics: true,
  onDemandNodes: 2,
  onDemandMetrics: true,
}
