import { CfnWaitCondition, CfnWaitConditionHandle, Construct, Duration, RemovalPolicy, Stack } from '@aws-cdk/core';
import {
  AmiHardwareType,
  AsgCapacityProvider,
  BaseService,
  BottleRocketImage,
  CfnTaskDefinition,
  Cluster,
  ContainerDependencyCondition,
  ContainerImage,
  DeploymentControllerType,
  Ec2Service,
  Ec2TaskDefinition,
  EcsOptimizedImage,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  MachineImageType,
  NetworkMode,
  Secret as ContainerSecret,
  TaskDefinition,
  UlimitName,
  Protocol as ContainerProtocol
} from '@aws-cdk/aws-ecs'
import {
  CfnLaunchTemplate,
  CloudFormationInit,
  InitCommand,
  InitConfig,
  InitFile,
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
import {
  AutoScalingGroup,
  CfnAutoScalingGroup,
  CfnLaunchConfiguration,
  HealthCheck,
  Signals,
  UpdatePolicy
} from '@aws-cdk/aws-autoscaling';
import { CockroachDecommissionHook } from './lib/cockroachDecommissionHook';
import { CockroachTaskDrainHook } from './lib/cockroachTaskDrainHook';
import { CockroachRebalanceDecommissionHook } from './lib/cockroachRebalanceDecommissionHook';
import { CockroachElbDeregisterHook } from './lib/cockroachElbDeregisterHook';
import { CockroachDatabase, CockroachDBCluster, CockroachDBSQLStatement, CockroachDBSQLUser } from './index';
import { CockroachInitializeAdminUser } from './lib/cockroachInitializeAdminUser';
import { ISecret } from '@aws-cdk/aws-secretsmanager';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachStartupHook } from './lib/cockroachStartupHook';
import { CockroachStartupTerminationWaitHook } from './lib/cockroachStartupTerminationWaitHook';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import { CONTAINER_PATH, getContainerPath } from './lib/lib';
import InstanceRequirementsProperty = CfnAutoScalingGroup.InstanceRequirementsProperty;

export class CockroachDBECS extends Construct implements CockroachDBCluster {
  private readonly internalBaseDomain = 'cockroach.db.crdb.com'
  private readonly internalDomainPrefix: string;
  private readonly internalDomain: string;
  private readonly options: CockroachDBECSOptionsWithDefaults;
  private readonly cluster: Cluster;
  public readonly vpc: IVpc;
  public readonly ca = new CockroachCA(this, 'cockroach-ca-certs')
  private readonly nodeCerts: CockroachNodeCertificates;
  public readonly rootCerts: CockroachClientCertificates;
  private readonly taskFamily: string;
  public readonly endpoint: string;
  public readonly adminSecret: ISecret;
  private readonly adminInit: CockroachInitializeAdminUser;
  private readonly cockroachTask: Ec2TaskDefinition;
  private readonly lb: NetworkLoadBalancer;
  private readonly cockroachService: Ec2Service;
  private poolUser?: CockroachDBSQLUser;

  private addValidation(options: CockroachDBECSOptionsWithDefaults) {
    this.node.addValidation({
      validate: () => {
        const errors = [];
        if (options.nodes < 3) {
          errors.push('CockroachDB requires a minimum of 3 nodes')
        }
        if (options.defaultReplicationFactor > options.nodes) {
          errors.push('Replication factor must be less than or equal to node count')
        }
        if (options.defaultReplicationFactor % 2 !== 1) {
          errors.push('Replication factor must be an odd number')
        }
        return errors;
      }
    })
  }

  constructor(stack: Construct, id: string, options: CockroachDBECSOptions) {
    super(stack, id);
    this.options = {
      ...CockroachDBECSOptionsDefaults,
      ...options,
    } as CockroachDBECSOptionsWithDefaults

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

    const capacity = this.addEc2SpotCapacity(this.cluster, this.options)
    this.lb = new NetworkLoadBalancer(this, 'cockroach-lb', {
      vpc: this.cluster.vpc,
      crossZoneEnabled: true,
      internetFacing: this.options.publiclyAvailable,
    })

    this.nodeCerts = this.ca.createNodeCertificates(this.optionalUniqueCertId('cockroach-node-certs'), [
      `*.${this.internalDomain}`,
      '*.internal',
      '*.ec2.internal',
      'localhost',
      '*.compute.internal',
      `*.${Stack.of(this).region}.compute.internal`,
      this.lb.loadBalancerDnsName,
    ])

    this.vpc = this.cluster.vpc;

    this.cockroachTask = this.configureTask(this.ca, this.nodeCerts, this.rootCerts);
    const {initTask, initWait} = this.runInitTask(this.cluster, this.ca, this.rootCerts);
    const service = this.configureService(this.cluster, capacity, this.cockroachTask);
    this.cockroachService = service;
    this.configurePrometheusMetrics(this.cluster)
    service.node.addDependency(initTask, capacity);
    this.configureLoadBalancerTargets(this.cluster, this.lb, service)
    this.handleInstanceTermination(this.cluster, service, capacity.autoScalingGroup, this.ca, this.rootCerts)
    this.endpoint = this.lb.loadBalancerDnsName;

    this.adminInit = new CockroachInitializeAdminUser(this, 'cockroach-admin-init', {
      vpc: this.cluster.vpc,
      caCerts: this.ca,
      rootCerts: this.rootCerts,
      endpoint: this.endpoint,
      username: this.options.adminUsername
    })

    this.adminInit.node.addDependency(initWait);
    this.adminSecret = this.adminInit.secret;

    this.runSql('db-settings-init',
      `set cluster setting kv.snapshot_recovery.max_rate = '${this.options.rebalanceRate}';
set cluster setting kv.snapshot_rebalance.max_rate = '${this.options.rebalanceRate}';
set cluster setting server.shutdown.drain_wait = '25s';
SET CLUSTER SETTING server.time_until_store_dead = '1m15s';
ALTER RANGE default CONFIGURE ZONE USING num_replicas = ${this.options.defaultReplicationFactor};`,
      undefined,
      undefined,
      true
    )
  }

  // public configureBouncer(poolUser: CockroachDBSQLUser) {
  //   if (this.poolUser) {
  //     throw new Error("Only a single pool user can be configured currently")
  //   }
  //   this.poolUser = poolUser;
  //
  //   const bouncerContainer = this.cockroachTask.addContainer('cockroach-bouncer', {
  //     essential: false,
  //     containerName: "pgbouncer-container",
  //     image: ContainerImage.fromAsset(getContainerPath("cockroach-bouncer")),
  //     secrets: {
  //       CA_CRT: ContainerSecret.fromSsmParameter(this.ca.caCrt),
  //       SERVER_CRT: ContainerSecret.fromSsmParameter(this.nodeCerts.nodeCrt),
  //       SERVER_KEY: ContainerSecret.fromSsmParameter(this.nodeCerts.nodeKey),
  //       POSTGRESQL_PASSWORD: ContainerSecret.fromSecretsManager(poolUser.secret, 'password')
  //     },
  //     environment: {
  //       POSTGRESQL_HOST: "localhost",
  //       POSTGRESQL_PORT: "26257",
  //       POSTGRESQL_USERNAME: poolUser.username,
  //       PGBOUNCER_PORT: "5432",
  //       PGBOUNCER_IGNORE_STARTUP_PARAMETERS: "extra_float_digits",
  //       PGBOUNCER_AUTH_TYPE: "plain",
  //       PGBOUNCER_POOL_MODE: "transaction",
  //       PGBOUNCER_DATABASE: "*",
  //       PGBOUNCER_MAX_CLIENT_CONN: "100000"
  //     },
  //     logging: LogDriver.awsLogs({streamPrefix: "bouncer"}),
  //     healthCheck: {
  //       command: ["curl", "--fail", "http://localhost:8080/health?ready=1"],
  //       startPeriod: Duration.seconds(300),
  //       interval: Duration.seconds(5),
  //       timeout: Duration.seconds(2),
  //     },
  //     portMappings: [{
  //       containerPort: 5432,
  //       hostPort: 5432,
  //       protocol: ContainerProtocol.TCP
  //     }],
  //     memoryReservationMiB: 30
  //   })
  //
  //   bouncerContainer.addUlimits({name: UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536},)
  //   bouncerContainer.addContainerDependencies({
  //     container: this.cockroachTask.findContainer("cockroachdb-container")!,
  //     condition: ContainerDependencyCondition.START
  //   })
  //
  //   this.lb.addListener('pgbouncer-listener', {
  //     port: 5432,
  //     protocol: ELBProtocol.TCP
  //   }).addTargets('pgbouncer-target', {
  //     healthCheck: {
  //       enabled: true,
  //       port: "8080",
  //       protocol: ELBProtocol.HTTP,
  //       path: "/health?ready=1",
  //       interval: Duration.seconds(10),
  //       unhealthyThresholdCount: 2,
  //       healthyThresholdCount: 2,
  //     },
  //     targets: [this.cockroachService.loadBalancerTarget({
  //       containerName: "pgbouncer-container",
  //       protocol: ContainerProtocol.TCP,
  //       containerPort: 5432
  //     })],
  //     deregistrationDelay: Duration.minutes(0),
  //     preserveClientIp: false,
  //     port: 5432,
  //     protocol: ELBProtocol.TCP,
  //   })
  // }

  public runSql(id: string, upQuery: string, downQuery?: string, database = "defaultdb", updateOnChange = false): CockroachDBSQLStatement {
    const statement = new CockroachDBSQLStatement(this, id, {
      cluster: this,
      upQuery, downQuery,
      database,
      updateOnChange
    })
    statement.node.addDependency(this.adminInit, this.cockroachService);
    return statement;
  }

  public addDatabase(id: string, database: string, removalPolicy: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY = RemovalPolicy.DESTROY): CockroachDatabase {
    const db = new CockroachDatabase(this, id, {
      cluster: this,
      database,
      removalPolicy
    })
    db.node.addDependency(this.adminInit);
    return db;
  }

  public automateBackup(bucket: Bucket, path: string = "backup", schedule?: string): CockroachDBSQLStatement {
    bucket.grantReadWrite(this.cockroachTask.taskRole)
    return this.runSql('automatic-backup',
      `create schedule dailybackup for backup into 's3://${bucket.bucketName}/${path}?AUTH=implicit'
with detached RECURRING '@daily'
full backup always 
with schedule options first_run = 'now';`,
      `drop schedules select id from [show schedules] where label = 'dailybackup';`)
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
        rule_files: [
          '/rules/aggregation.rules.yml'
        ],
        scrape_configs: [
          {
            tls_config: {
              insecure_skip_verify: true
            },
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
      image: ContainerImage.fromAsset(getContainerPath('cw-agent')),
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
      // enableExecuteCommand: true,
    });

    return cwAgentService;
  }

  /**
   * Nodes on terminating instances need to be decommissioned as their local data will be lost
   */
  private handleInstanceTermination(cluster: Cluster, service: Ec2Service, asg: AutoScalingGroup, ca: CockroachCA, rootCerts: CockroachClientCertificates) {
    service.node.addDependency(
      new CockroachDecommissionHook(this, 'decommission-hook', {
        ca, rootCerts, cluster, asg
      }),
      new CockroachTaskDrainHook(this, 'drain-hook', {
        asg, cluster
      }),
      new CockroachRebalanceDecommissionHook(this, 'rebalance-hook', {
        cluster, ca, rootCerts
      }),
      new CockroachElbDeregisterHook(this, 'deregister-hook', {
        cluster,
        ca,
        rootCerts
      }),
    )
    new CockroachStartupHook(this, 'startup-hook', {
      asg, cluster, service
    })
    new CockroachStartupTerminationWaitHook(this, 'startup-wait-hook', {
      asg
    })
  }

  private configureTask(caCerts: CockroachCA, nodeCerts: CockroachNodeCertificates, rootCerts: CockroachClientCertificates): Ec2TaskDefinition {
    const mountPoint = "/mnt";
    const volumeConfigs = [...new Array(5)].map((_, idx) => (
      {
        name: "drive" + idx,
        host: {
          sourcePath: join(mountPoint, "drive" + idx)
        }
      }
    ));

    const task = new Ec2TaskDefinition(this, 'cockroach-task', {
      family: this.taskFamily,
      // We only run a single instance per node, so host makes the most of our network performance
      networkMode: NetworkMode.HOST,
      volumes: volumeConfigs,
    })

    task.addToTaskRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ecs:ListTagsForResource",
        "autoscaling:DescribeAutoScalingInstances",
        "ecs:DescribeContainerInstances",
        "ecs:DescribeTasks",
        "ecs:ListContainerInstances",
        "ecs:ListTasks",
      ],
      resources: ["*"]
    }))

    this.options.importBuckets.forEach(bucket => bucket.grantRead(task.taskRole));
    this.options.exportBuckets.forEach(bucket => bucket.grantWrite(task.taskRole))

    const container = task.addContainer('cockroachdb', {
      stopTimeout: Duration.minutes(60),
      containerName: "cockroachdb-container",
      logging: LogDriver.awsLogs({streamPrefix: "cockroach"}),
      memoryReservationMiB: 1024,
      portMappings: [{containerPort: 8080, protocol: ContainerProtocol.TCP, hostPort: 8080}, {
        containerPort: 26257,
        protocol: ContainerProtocol.TCP,
        hostPort: 26257
      }, {containerPort: 26258, protocol: ContainerProtocol.TCP, hostPort: 26258}],
      healthCheck: {
        command: ["curl", "--fail", "http://localhost:8080/health?ready=1"],
        startPeriod: Duration.seconds(300),
        interval: Duration.seconds(5),
        timeout: Duration.seconds(2),
      },
      secrets: {
        COCKROACH_CA_CRT: ContainerSecret.fromSsmParameter(caCerts.caCrt),
        COCKROACH_NODE_CRT: ContainerSecret.fromSsmParameter(nodeCerts.nodeCrt),
        COCKROACH_NODE_KEY: ContainerSecret.fromSsmParameter(nodeCerts.nodeKey),
        COCKROACH_ROOT_CRT: ContainerSecret.fromSsmParameter(rootCerts.clientCrt),
        COCKROACH_ROOT_KEY: ContainerSecret.fromSsmParameter(rootCerts.clientKey),
      },
      environment: {
        COCKROACH_SKIP_KEY_PERMISSION_CHECK: "true",
        COCKROACH_DOMAIN: this.internalDomain,
        AWS_REGION: Stack.of(this).region,
        MIN_PEERS: (this.options.nodes > 3 ? 3 : 2) + ""
      },
      image: ContainerImage.fromAsset(getContainerPath('cockroach-bootstraped'), {
        buildArgs: {
          COCKROACH_IMAGE: this.options.cockroachImage
        }
      }),
      command: [
        "start",
        "--cluster-name=cockroach",
        "--cache=.25",
        "--max-sql-memory=.25",
        "--http-port=8080",
        "--sql-addr=:26257",
        "--listen-addr=:26258",
      ],
      essential: true
    })
    container.addMountPoints(...volumeConfigs.map(config => ({
      containerPath: join("/cockroach", "drives", config.name),
      readOnly: false,
      sourceVolume: config.name
    })))
    // Raise file limits
    container.addUlimits({name: UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536},)

    return task;
  }

  private runInitTask(cluster: Cluster, caCerts: CockroachCA, rootCerts: CockroachClientCertificates) {
    const waitConditionHandle = new CfnWaitConditionHandle(this, 'init-wait-handle')

    const initWaitCondition = new CfnWaitCondition(this, 'init-wait', {
      count: 1,
      timeout: Duration.minutes(30).toSeconds().toString(),
      handle: waitConditionHandle.ref,
    })

    const task = new FargateTaskDefinition(this, 'cockroach-init-task', {
      cpu: 256,
      memoryLimitMiB: 512,
    })

    task.addContainer('cockroach-init-container', {
      containerName: "cockroach-init",
      logging: LogDriver.awsLogs({streamPrefix: 'cockroach-init'}),
      image: ContainerImage.fromAsset(getContainerPath('cockroach-initializer'), {
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
        COCKROACH_DOMAIN: this.internalDomain,
        INIT_SIGNAL: waitConditionHandle.ref
      },
      command: ["--cluster-name=cockroach"],
    })

    const run = new RunTask(this, 'cockroach-init-task-run', {
      cluster,
      vpc: cluster.vpc,
      task,
    })

    run.node.addDependency(task);
    return {
      initTask: run,
      initWait: initWaitCondition
    };
  }

  private configureService(cluster: Cluster, capacityProvider: AsgCapacityProvider, task: TaskDefinition) {

    const service = new Ec2Service(this, 'cockroach-service', {
      cluster,
      serviceName: "cockroach-service",
      minHealthyPercent: Math.floor(((this.options.nodes - 1) / this.options.nodes) * 100),
      daemon: true,
      maxHealthyPercent: 100,
      cloudMapOptions: {
        dnsTtl: Duration.seconds(1),
        name: this.internalDomainPrefix,
        dnsRecordType: DnsRecordType.SRV,
        containerPort: 26258,
        container: task.findContainer("cockroachdb-container")
      },
      deploymentController: {
        type: DeploymentControllerType.ECS,
      },
      circuitBreaker: {
        rollback: true,
      },
      taskDefinition: task,
      healthCheckGracePeriod: Duration.minutes(60),
    })

    service.node.addDependency(capacityProvider, cluster.vpc)
    return service;
  }

  private addEc2SpotCapacity(cluster: Cluster, options: CockroachDBECSOptionsWithDefaults) {
    const amazonLinuxInit = new InitConfig([
      InitFile.fromAsset('/var/lib/cloud/scripts/per-boot/mount.sh', join(CONTAINER_PATH, 'ephemeral-bootstrap', 'setup.sh'), {mode: '000700'}),
      InitCommand.argvCommand(["/var/lib/cloud/scripts/per-boot/mount.sh"]),
      InitCommand.shellCommand('echo ECS_IMAGE_PULL_BEHAVIOR=prefer-cached >> /etc/ecs/ecs.config'),
      InitCommand.shellCommand('echo ECS_RESERVED_MEMORY=128 >> /etc/ecs/ecs.config'),
      InitCommand.shellCommand('echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config')
    ])

    const serviceSG = new SecurityGroup(this, 'cockroach-service-sg', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
    })

    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26257), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(26258), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(8080), 'cockroach-sql-access')
    serviceSG.addIngressRule(Peer.ipv4(cluster.vpc.vpcCidrBlock), Port.tcp(5432), 'cockroach-sql-access')

    const bootstrapImage = new DockerImageAsset(this, 'bootstrap-image', {
      directory: getContainerPath('ephemeral-bootstrap')
    })

    const asg = new AutoScalingGroup(this, 'cockroach-asg', {
      allowAllOutbound: true,
      securityGroup: serviceSG,
      machineImage: (this.options.instanceAmi === MachineImageType.BOTTLEROCKET) ? new BottleRocketImage({cachedInContext: true}) : EcsOptimizedImage.amazonLinux2(AmiHardwareType.STANDARD),
      updatePolicy: UpdatePolicy.rollingUpdate({
        minInstancesInService: options.nodes - 1,
        maxBatchSize: Math.max(Math.floor(options.nodes / 3), 1),
        waitOnResourceSignals: this.options.instanceAmi === MachineImageType.AMAZON_LINUX_2,
      }),
      instanceType: InstanceType.of(InstanceClass.C5AD, InstanceSize.XLARGE),
      vpc: cluster.vpc,
      minCapacity: options.nodes,
      healthCheck: HealthCheck.ec2({
        grace: Duration.minutes(2)
      }),
      // healthCheck: HealthCheck.elb({
      //   grace: Duration.minutes(5)
      // })
      maxCapacity: options.nodes,
      ...((this.options.instanceAmi === MachineImageType.AMAZON_LINUX_2) ? {
        init: CloudFormationInit.fromConfig(amazonLinuxInit),
        initOptions: {
          embedFingerprint: true,
        },
        signals: Signals.waitForAll(),
      } : {}),
      newInstancesProtectedFromScaleIn: false,
      cooldown: Duration.minutes(25),
    })

    bootstrapImage.repository.grantPull(asg.role)

    asg.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))
    asg.role.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ecs:UpdateContainerInstancesState"
      ],
      resources: ["*"],
      conditions: {
        ArnEquals: {
          "ecs:cluster": cluster.clusterArn
        }
      }
    }))

    const provider = new AsgCapacityProvider(this, 'cockroach-asg-provider', {
      autoScalingGroup: asg,
      spotInstanceDraining: true,
      enableManagedScaling: false,
      machineImageType: this.options.instanceAmi,
      enableManagedTerminationProtection: false,
    });
    provider.node.addDependency(asg);
    cluster.addAsgCapacityProvider(provider)

    // ECS AMI is missing the cfn-amazonLinuxInit scripts, and cdk ignores this
    // We force the installation to happen before user data tries to call the scripts.
    if (this.options.instanceAmi === MachineImageType.AMAZON_LINUX_2) {
      const userData = (asg.userData as any);
      userData.lines = [
        'yum install -y aws-cfn-bootstrap',
        ...userData.lines
      ]
    } else {
      asg.userData.addCommands(
        'enable-spot-instance-draining = true',
        '[settings.bootstrap-containers.setup-ephemeral-disks]',
        `source = "${bootstrapImage.imageUri}"`,
        'mode = "always"',
        'essential = false'
      )
    }


    const cfnAsg = asg.node.defaultChild as CfnAutoScalingGroup;

    const cfnLaunchConfig = asg.node.tryFindChild('LaunchConfig') as CfnLaunchConfiguration;
    asg.node.tryRemoveChild('LaunchConfig');
    cfnAsg.instanceId = undefined;
    cfnAsg.launchTemplate = undefined;
    cfnAsg.launchConfigurationName = undefined;

    // const cfnLaunchTemplate = launchTemplate.node.defaultChild as CfnLaunchTemplate;
    const cfnLaunchTemplate = new CfnLaunchTemplate(this, 'cockroach-launch-template', {
      launchTemplateData: {
        userData: cfnLaunchConfig.userData,
        securityGroupIds: cfnLaunchConfig.securityGroups,
        iamInstanceProfile: {name: cfnLaunchConfig.iamInstanceProfile},
        monitoring: {enabled: true},
        keyName: cfnLaunchConfig.keyName,
        imageId: cfnLaunchConfig.imageId,
        instanceInitiatedShutdownBehavior: 'terminate',
      }
    })

    // We do our own capacity rebalancing
    cfnAsg.capacityRebalance = false;

    // Terminate old instances by spot availability
    cfnAsg.terminationPolicies = ['AllocationStrategy'];

    cfnAsg.mixedInstancesPolicy = {
      instancesDistribution: {
        spotAllocationStrategy: 'capacity-optimized',
        onDemandBaseCapacity: options.onDemandNodes,
        onDemandPercentageAboveBaseCapacity: 0,
      },
      launchTemplate: {
        launchTemplateSpecification: {
          launchTemplateId: cfnLaunchTemplate.ref,
          version: cfnLaunchTemplate.attrLatestVersionNumber
        },
        overrides: [
          {
            instanceRequirements: this.options.instanceRequirements
          }
        ]
      }
    }
    return provider;
  }

  private configureLoadBalancerTargets(cluster: Cluster, nlb: NetworkLoadBalancer, service: BaseService) {
    const sqlTarget = nlb.addListener('sql-listener', {
      port: 26257,
      protocol: ELBProtocol.TCP
    }).addTargets('cockroach-sql-target', {
      targets: [service.loadBalancerTarget({
        containerName: "cockroachdb-container",
        containerPort: 26257,
      })],
      deregistrationDelay: Duration.seconds(0),
      preserveClientIp: false,
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

    const webTarget = nlb.addListener('console-listener', {
      port: 443,
      protocol: ELBProtocol.TCP,
    }).addTargets('cockroach-console-target', {
      targets: [service.loadBalancerTarget({
        containerName: "cockroachdb-container",
        containerPort: 8080,
      })],
      deregistrationDelay: Duration.seconds(0),
      preserveClientIp: false,
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
            "emf_processor": {
              metric_declaration_dedup: true,
              metric_namespace: "CockroachDB",
              metric_unit: {
                ranges_underreplicated: "Count",
                ranges_unavailable: "Count",
                capacity_used: "Byte",
                capacity_available: "Byte",
                replicas: "Count",
                replicas_leaders: "Count",
                replicas_leaseholders: "Count"
              },
              metric_declaration: [
                {
                  source_labels: ["store"],
                  label_matcher: '^.*',
                  dimensions: [["ClusterName", "store", "instance"]],
                  metric_selectors: [
                    "^ranges_underreplicated$",
                    "^ranges_unavailable$",
                    "^capacity_available$",
                    "^capacity_used$",
                    "^replicas",
                  ]
                },
                {
                  source_labels: ["store"],
                  label_matcher: '^.*',
                  dimensions: [["ClusterName", "store", "instance"]],
                  metric_selectors: [
                    "^replicas_leaders",
                    "^replicas_leaseholders",
                  ]
                }
              ],
            },
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
          },
        }
      },
      force_flush_interval: 5,
      agent: {
        metrics_collection_interval: 60,
        debug: true
      }
    } as const;
  }
}

export interface CockroachDBECSOptions {
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
   * CockroachDB docker image to use
   * @default cockroachdb/cockroach:v21.2.2
   */
  cockroachImage?: string;

  /**
   * Rotate node and root certificates on every deployment. Will trigger a rolling update every time, so be ready to wait.
   * Turning this on/off also triggers a deployment
   * @default false
   */
  rotateCertsOnDeployment?: boolean;

  /**
   * Enables enhanced metrics for the cluster. Extra charges will apply for additional custom metrics, and a (small) additional container to run the cloudwatch agent.
   * @default true
   */
  enhancedMetrics?: boolean

  /**
   * Run a minimum number of on demand instances. Recommend at least 2 for high availability
   * @default 2
   */
  onDemandNodes?: number;

  /**
   * Percentage of on demand instances to run above base on demand capacity
   * @default 0
   */
  onDemandRatio?: number;

  /**
   * Run metrics agent with on demand capacity. This is more expensive, but will guarantee metric availability
   * @default true
   */
  onDemandMetrics?: boolean;

  /**
   * Username for the created admin user
   */
  adminUsername: string;

  /**
   * Give cluster read access to S3 buckets
   */
  importBuckets?: Bucket[],

  /**
   * Give cluster write access to S3 buckets
   */
  exportBuckets?: Bucket[],

  /**
   * The default replica count for the cluster. Should be an odd number less than or equal to your node count
   * @default 3
   */
  defaultReplicationFactor?: number

  /**
   * Sets the AMI deployed to ECS instances. Probably just leave this set to BOTTLEROCKET
   * @default MachineImageType.BOTTLEROCKET
   */
  instanceAmi?: MachineImageType

  /**
   * Controls what type of instances will be selected by the autoscaling group.
   */
  instanceRequirements?: InstanceRequirementsProperty

  /**
   * Rate at which ranges will rebalance within the cluster.
   * Only really needs to be changed when using limited burstable instances.
   * @default "256 MB"
   */
  rebalanceRate?: '256 MB' | '128 MB' | '64 MB' | '32 MB' | '16 MB'

  /**
   * Whether the loadbalancer should be publicly available.
   * This should be false in production deployments.
   * @default false
   */
  publiclyAvailable?: boolean
}

type CockroachDBECSOptionsWithDefaults =
  CockroachDBECSOptions
  & typeof CockroachDBECSOptionsDefaults;

export const ProductionInstanceRequirements: InstanceRequirementsProperty = {
  instanceGenerations: ["current"],
  vCpuCount: {
    max: 4,
    min: 4
  },
  memoryGiBPerVCpu: {
    min: 2,
    max: 8
  },
  memoryMiB: {
    min: 16 * 1024,
    max: 32 * 1024
  },
  acceleratorCount: {max: 0},
  totalLocalStorageGb: {min: 60, max: 300},
  localStorageTypes: ["ssd"],
  cpuManufacturers: ["intel", 'amd'],
  burstablePerformance: 'excluded',
  localStorage: 'required',
  bareMetal: "excluded",
}

export const SmallProductionInstanceRequirements: InstanceRequirementsProperty = {
  instanceGenerations: ["current"],
  vCpuCount: {
    max: 2,
    min: 2
  },
  memoryGiBPerVCpu: {
    min: 2,
    max: 8
  },
  memoryMiB: {
    min: 8 * 1024,
    max: 16 * 1024
  },
  acceleratorCount: {max: 0},
  totalLocalStorageGb: {min: 60, max: 300},
  localStorageTypes: ["ssd"],
  cpuManufacturers: ["intel", 'amd'],
  burstablePerformance: 'excluded',
  localStorage: 'required',
  bareMetal: "excluded",
}

export const BigProductionInstanceRequirements: InstanceRequirementsProperty = {
  instanceGenerations: ["current"],
  vCpuCount: {
    max: 8,
    min: 8
  },
  memoryGiBPerVCpu: {
    min: 2,
    max: 8
  },
  memoryMiB: {
    min: 16 * 1024,
    max: 64 * 1024
  },
  acceleratorCount: {max: 0},
  totalLocalStorageGb: {min: 60, max: 500},
  localStorageTypes: ["ssd"],
  cpuManufacturers: ["intel", 'amd'],
  burstablePerformance: 'excluded',
  localStorage: 'required',
  bareMetal: "excluded",
}
export const DevelopmentInstanceRequirements: InstanceRequirementsProperty = {
  cpuManufacturers: ["intel", 'amd'],
  burstablePerformance: 'required',
  memoryMiB: {
    min: 2 * 1024,
    max: 2 * 1024
  },
  instanceGenerations: ["current"],
  vCpuCount: {
    min: 2,
    max: 2
  },
}


const CockroachDBECSOptionsDefaults = {
  nodes: 3,
  cockroachImage: "cockroachdb/cockroach:v21.2.4",
  rotateCertsOnDeployment: false,
  enhancedMetrics: true,
  onDemandNodes: 2,
  onDemandMetrics: true,
  importBuckets: [] as Bucket[],
  exportBuckets: [] as Bucket[],
  defaultReplicationFactor: 3,
  onDemandRatio: 0,
  instanceAmi: MachineImageType.AMAZON_LINUX_2,
  instanceRequirements: ProductionInstanceRequirements,
  rebalanceRate: '256 MB',
  publiclyAvailable: false,
}
