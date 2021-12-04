import { Construct, CustomResource, Duration, Stack } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, InstanceType, LaunchTemplate, SubnetSelection, Vpc } from '@aws-cdk/aws-ec2';
import {
  CapacityType,
  Cluster,
  EndpointAccess, FargateCluster,
  KubernetesManifest,
  KubernetesObjectValue,
  KubernetesVersion, Nodegroup
} from '@aws-cdk/aws-eks';
import { default as request } from 'sync-request'
import {
  AnyPrincipal,
  Effect,
  IRole,
  ManagedPolicy, Policy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal
} from '@aws-cdk/aws-iam'
import { load, loadAll } from 'js-yaml'
import { CfnSecret, ISecret, Secret } from '@aws-cdk/aws-secretsmanager'
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs'
import { Provider } from '@aws-cdk/custom-resources'
import { join } from 'path';
import { readFileSync } from 'fs';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachDbUserCreateProvider } from './cockroachDbUserCreateProvider';
import { CockroachDbRunSQLProvider } from './cockroachDbRunSQLProvider';

const COCKROACHDB_CRD_URL = 'https://raw.githubusercontent.com/cockroachdb/cockroach-operator/v2.4.0/install/crds.yaml';
const COCKROACHDB_OPERATOR_MANIFEST_URL = 'https://raw.githubusercontent.com/cockroachdb/cockroach-operator/v2.4.0/install/operator.yaml';

export class CockroachDBEKSCluster extends Construct {
  public readonly loadbalancerAddress: string;
  private readonly kubeCluster: Cluster
  private readonly clusterConfigDeployment: KubernetesManifest
  private readonly dbInitResource: Construct;
  private readonly rootSecret: Secret;
  private readonly rootCertificatesSecret: ISecret;
  private readonly options: CockroachClusterConfig;
  private readonly userCreateProvider: CockroachDbUserCreateProvider;
  private readonly runSQLProvider: CockroachDbRunSQLProvider;

  public clusterAccessRole = new Role(this, 'cockroachdb-cluster-access-role', {
    assumedBy: new AnyPrincipal(),
  });

  private addClusterCapacity(cluster: Cluster, options: CockroachClusterConfig) {

    const vpc = this.kubeCluster.vpc;
    const perAzCapacity = Math.trunc(options.desiredNodes / vpc.availabilityZones.length);
    const remainder = options.desiredNodes % vpc.availabilityZones.length;
    const nodegroups: Nodegroup[] = [];
    const capacityList = vpc.availabilityZones.map((az) => ({
      capacity: perAzCapacity,
      az,
    }));
    capacityList[0].capacity += remainder;

    const csiPolicy = new Policy(this, 'ebs-csi-role', {
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:CreateSnapshot", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:ModifyVolume", "ec2:DescribeAvailabilityZones", "ec2:DescribeInstances", "ec2:DescribeSnapshots", "ec2:DescribeTags", "ec2:DescribeVolumes", "ec2:DescribeVolumesModifications"],
          resources: ["*"]
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:CreateTags"],
          resources: ["arn:aws:ec2:*:*:volume/*", "arn:aws:ec2:*:*:snapshot/*"],
          conditions: {"StringEquals": {"ec2:CreateAction": ["CreateVolume", "CreateSnapshot"]}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteTags"],
          resources: ["arn:aws:ec2:*:*:volume/*", "arn:aws:ec2:*:*:snapshot/*"]
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:CreateVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"aws:RequestTag/ebs.csi.aws.com/cluster": "true"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:CreateVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"aws:RequestTag/CSIVolumeName": "*"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:CreateVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"aws:RequestTag/kubernetes.io/cluster/*": "owned"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"ec2:ResourceTag/ebs.csi.aws.com/cluster": "true"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"ec2:ResourceTag/CSIVolumeName": "*"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteVolume"],
          resources: ["*"],
          conditions: {"StringLike": {"ec2:ResourceTag/kubernetes.io/cluster/*": "owned"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteSnapshot"],
          resources: ["*"],
          conditions: {"StringLike": {"ec2:ResourceTag/CSIVolumeSnapshotName": "*"}}
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ec2:DeleteSnapshot"],
          resources: ["*"],
          conditions: {"StringLike": {"ec2:ResourceTag/ebs.csi.aws.com/cluster": "true"}}
        }),
      ]
    })

    capacityList.forEach(placement => {
      const nodegroup = cluster.addNodegroupCapacity('cockroach-cluster-capacity-' + placement.az, {
        capacityType: CapacityType.SPOT,
        minSize: placement.capacity,
        maxSize: placement.capacity * 2,
        // nodeRole,
        subnets: {
          availabilityZones: [placement.az]
        },
        desiredSize: placement.capacity,
        instanceTypes: options.instanceTypes,
      })

      nodegroup.node.addDependency(...nodegroups)
      nodegroup.role.addToPrincipalPolicy(new PolicyStatement({
        actions: [
          'ssm:UpdateInstanceInformation',
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
          's3:GetEncryptionConfiguration',
        ],
        effect: Effect.ALLOW,
        resources: ['*'],
      }))
      nodegroup.role.attachInlinePolicy(csiPolicy)
      options.s3ReadBuckets.forEach(bucket => bucket.grantRead(nodegroup.role))
      options.s3WriteBuckets.forEach(bucket => bucket.grantWrite(nodegroup.role))

      nodegroups.push(nodegroup);
    })
    return nodegroups;
  }

  private addCockroachControlResources(cluster: Cluster) {
    const cockroachOperatorManifest = loadAll(readFileSync(join(__dirname, '..', 'operator.yaml')).toString())
    const cockroachCRD = load(request('GET', COCKROACHDB_CRD_URL).body.toString());

    return this.kubeCluster.addManifest('cockroachdb-control-manifest', cockroachCRD, ...cockroachOperatorManifest);
  }

  private configureStorage(cluster: Cluster) {
    return cluster.addHelmChart('ebs-csi', {
      repository: "https://kubernetes-sigs.github.io/aws-ebs-csi-driver",
      chart: "aws-ebs-csi-driver",
      wait: true,
      release: "aws-ebs-csi-driver",
      namespace: "kube-system",
      values: {
        storageClasses: [
          {
            name: "gp3",
            annotations: {
              "storageclass.kubernetes.io/is-default-class": "true"
            },
            volumeBindingMode: "WaitForFirstConsumer",
            allowVolumeExpansion: true,
            parameters: {
              type: "gp3"
            }
          }
        ]
      }
    })
  }

  private validateOptions(options: CockroachClusterConfig) {
    if (options.desiredNodes <= 3) {
      throw new Error("desiredNodes must be greater than or equal to 3")
    }
  }

  constructor(scope: Construct, id: string, options: CockroachClusterConfig) {
    super(scope, id);

    this.validateOptions(options);

    this.options = {
      ...CockroachClusterDefaults,
      ...options
    }

    this.kubeCluster = new Cluster(this, 'cockroach-cluster', {
      version: KubernetesVersion.V1_21,
      defaultCapacity: 0,
      vpc: this.options.vpc,
      vpcSubnets: this.options.vpcSubnets,
      endpointAccess: this.options.kubeEndpointPublic ? EndpointAccess.PUBLIC_AND_PRIVATE : EndpointAccess.PRIVATE,
    })

    this.kubeCluster.awsAuth.addMastersRole(this.clusterAccessRole)

    const nodeGroup = this.addClusterCapacity(this.kubeCluster, this.options)

    const cockroachCluster = {
      "apiVersion": "crdb.cockroachlabs.com/v1alpha1",
      "kind": "CrdbCluster",
      "metadata": {
        "name": "cockroachdb",
        "namespace": "cockroach-operator-system"
      },
      "spec": {
        "dataStore": {
          "supportsAutoResize": true,
          "pvc": {
            "spec": {
              storageClassName: "gp3",
              "accessModes": [
                "ReadWriteOnce"
              ],
              "resources": {
                "requests": {
                  "storage": this.options.storageRequest + "Gi"
                }
              },
              "volumeMode": "Filesystem",
            }
          }
        },
        "resources": {
          "requests": {
            "cpu": 1,
            "memory": "4Gi"
          },
        },
        "tlsEnabled": true,
        "image": {
          "name": this.options.cockroachImage
        },
        "nodes": this.options.desiredNodes,
        "additionalLabels": {
          "crdb": "cockroach-cluster"
        }
      }
    }

    const loadBalancerManifest = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: "cockroachdb-lb", "namespace": "cockroach-operator-system", annotations: {
          "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
        }
      },
      spec: {
        type: 'LoadBalancer',
        ports: [{port: 26257, targetPort: 26257}],
        selector: {"crdb": "cockroach-cluster"}
      }
    }

    const storageSetup = this.configureStorage(this.kubeCluster);
    const operator = this.addCockroachControlResources(this.kubeCluster);

    this.clusterConfigDeployment = this.kubeCluster.addManifest('cockroachdb-cluster-manifest', cockroachCluster)

    const loadBalancer = this.kubeCluster.addManifest('cockroach-lb', loadBalancerManifest)

    this.clusterConfigDeployment.node.addDependency(...nodeGroup, operator, storageSetup)

    loadBalancer.node.addDependency(this.clusterConfigDeployment)

    const lbAddressObjectValue = new KubernetesObjectValue(this, 'loadbalancer-address', {
      cluster: this.kubeCluster,
      jsonPath: '.status.loadBalancer.ingress[0].hostname',
      objectType: 'service',
      objectName: 'cockroachdb-lb',
      objectNamespace: 'cockroach-operator-system'
    });
    lbAddressObjectValue.node.addDependency(loadBalancer);

    this.rootCertificatesSecret = this.getRootKeys(this.kubeCluster, this.clusterConfigDeployment)
    this.loadbalancerAddress = lbAddressObjectValue.value;
    const initialization = this.dbInit(this.kubeCluster, options.rootUsername, options.database, this.rootCertificatesSecret)
    this.rootSecret = initialization.rootSecret;
    this.dbInitResource = initialization.dbInitResource;
    this.userCreateProvider = new CockroachDbUserCreateProvider(this, 'user-create-provider', this.rootSecret, this.loadbalancerAddress, this.kubeCluster.kubectlPrivateSubnets ? this.kubeCluster.vpc : undefined, this.kubeCluster.kubectlPrivateSubnets ? this.kubeCluster.kubectlPrivateSubnets : undefined)
    this.runSQLProvider = new CockroachDbRunSQLProvider(this, 'run-sql-provider', this.rootSecret, this.loadbalancerAddress, this.kubeCluster.kubectlPrivateSubnets ? this.kubeCluster.vpc : undefined, this.kubeCluster.kubectlPrivateSubnets ? this.kubeCluster.kubectlPrivateSubnets : undefined)
  }

  private getRootKeys(cluster: Cluster, clusterDeployment: KubernetesManifest): ISecret {
    const caCertObjectValue = new KubernetesObjectValue(this, 'root-certificates-ca', {
      cluster,
      objectType: "secret",
      objectName: "cockroachdb-root",
      objectNamespace: "cockroach-operator-system",
      jsonPath: ".data.ca\\.crt"
    });
    caCertObjectValue.node.addDependency(clusterDeployment)
    const rootCertObjectValue = new KubernetesObjectValue(this, 'root-certificates-crt', {
      cluster,
      objectType: "secret",
      objectName: "cockroachdb-root",
      objectNamespace: "cockroach-operator-system",
      jsonPath: ".data.tls\\.crt",
    });
    rootCertObjectValue.node.addDependency(clusterDeployment)
    const rootKeyObjectValue = new KubernetesObjectValue(this, 'root-certificates-key', {
      cluster,
      objectType: "secret",
      objectName: "cockroachdb-root",
      objectNamespace: "cockroach-operator-system",
      jsonPath: ".data.tls\\.key"
    });
    rootKeyObjectValue.node.addDependency(clusterDeployment)
    const rootCertificatesSecret = new CfnSecret(this, 'root-cert-secret', {
      secretString: JSON.stringify({
        caCrt: caCertObjectValue.value,
        rootCrt: rootCertObjectValue.value,
        rootKey: rootKeyObjectValue.value
      })
    })
    return Secret.fromSecretAttributes(this, 'root-cert-secert-con', {
      secretCompleteArn: rootCertificatesSecret.ref
    })
  }

  public addUser(username: string) {
    const secret = this.userCreateProvider.addUser(username, this.options.database);
    secret.node.addDependency(this.dbInitResource);
    return secret;
  }

  public runSql(id: string, upQuery: string, downQuery: string) {
    const resource = this.runSQLProvider.runSQL(id, this.options.database, upQuery, downQuery);
    resource.node.addDependency(this.dbInitResource);
    return resource;
  }

  public automateBackup(bucket: Bucket, path: string = "", schedule: string = '@daily') {
    return this.runSql('automatic-backups',
      `create schedule dailybackup for backup into 's3://${bucket.bucketName}/${path}?AUTH=implicit'
with detached RECURRING '@daily'
full backup always 
with schedule options first_run = 'now';`,
      `drop schedules select id from [show schedules] where label = 'dailybackup';`
      )
  }

  private dbInit(cluster: Cluster, username: string, database: string, rootCertSecret: ISecret) {
    const dbInitLambda = new NodejsFunction(this, 'cockroach-db-init-lambda', {
      vpc: this.kubeCluster.kubectlPrivateSubnets ? cluster.vpc : undefined,
      bundling: {
        minify: true,
        externalModules: ['pg-native', 'aws-sdk']
      },
      entry: join(__dirname, "cockroachDbInitializationHandler.js"),
      timeout: Duration.minutes(15),
      securityGroups: cluster.kubectlSecurityGroup ? [cluster.kubectlSecurityGroup] : undefined,
      vpcSubnets: cluster.kubectlPrivateSubnets ? {subnets: cluster.kubectlPrivateSubnets} : undefined
    })

    const dbInitProvider = new Provider(this, 'db-init-lambda-provider', {
      onEventHandler: dbInitLambda,
      vpc: cluster.kubectlPrivateSubnets ? cluster.vpc : undefined,
      securityGroups: cluster.kubectlSecurityGroup ? [cluster.kubectlSecurityGroup] : undefined,
      vpcSubnets: cluster.kubectlPrivateSubnets ? {subnets: cluster.kubectlPrivateSubnets} : undefined
    });

    const secretData: Omit<CockroachDBUserSecret, 'password'> = {
      isAdmin: true,
      username,
      endpoint: this.loadbalancerAddress,
      port: 26257
    }
    const secret = new Secret(this, `root-user-secret`, {
      generateSecretString: {
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 20,
        includeSpace: false,
        secretStringTemplate: JSON.stringify(secretData)
      }
    })
    rootCertSecret.grantRead(dbInitLambda);
    secret.grantRead(dbInitLambda);
    const dbInitResource = new CustomResource(this, `root-user`, {
      serviceToken: dbInitProvider.serviceToken,
      properties: {
        userSecretId: secret.secretArn,
        rootCertsSecretId: rootCertSecret.secretArn,
        database,
      }
    })

    dbInitResource.node.addDependency(this.clusterConfigDeployment, secret)
    return {
      rootSecret: secret,
      dbInitResource
    };
  }
}

const CockroachClusterDefaults: Omit<CockroachClusterConfig, 'vpc' | 'database' | 'rootUsername'> = {
  kubeEndpointPublic: true,
  desiredNodes: 3,
  instanceTypes: [
    InstanceType.of(InstanceClass.M6I, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.C6I, InstanceSize.XLARGE),
    new InstanceType('m6a.xlarge'),
    InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.C5N, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.C5D, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.M5, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.M5N, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.M5D, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.C5A, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.C5AD, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.M5A, InstanceSize.XLARGE),
    InstanceType.of(InstanceClass.M5AD, InstanceSize.XLARGE),
  ],
  cockroachImage: "cockroachdb/cockroach:v21.2.0",
  publiclyAvailable: false,
  storageRequest: 50,
}

export interface CockroachClusterConfig {
  vpc: Vpc,
  vpcSubnets?: SubnetSelection[],
  kubeEndpointPublic?: boolean,
  desiredNodes?: number,
  instanceTypes?: InstanceType[],
  publiclyAvailable?: boolean,
  storageRequest?: number,
  cockroachImage?: string,
  s3ReadBuckets?: Bucket[],
  s3WriteBuckets?: Bucket[],

  rootUsername: string,
  database: string;
}

export interface CockroachDBUserSecret {
  username: string;
  password: string;
  endpoint: string;
  isAdmin: boolean;
  port: number;
}

export interface CockroachRootCertificateSecret {
  caCrt: string;
  rootCrt: string;
  rootKey: string;
}
