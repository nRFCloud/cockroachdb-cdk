import { Construct, CustomResource, Duration, RemovalPolicy } from '@aws-cdk/core';
import { InstanceClass, InstanceSize, InstanceType, IVpc, Subnet, SubnetSelection, Vpc } from '@aws-cdk/aws-ec2';
import {
  AlbControllerVersion,
  CapacityType, CfnAddon,
  Cluster,
  EndpointAccess,
  KubernetesManifest,
  KubernetesObjectValue,
  KubernetesVersion,
  Nodegroup
} from '@aws-cdk/aws-eks';
import { default as request } from 'sync-request'
import { AnyPrincipal, Effect, Policy, PolicyStatement, Role } from '@aws-cdk/aws-iam'
import { load, loadAll } from 'js-yaml'
import { CfnSecret, ISecret, Secret } from '@aws-cdk/aws-secretsmanager'
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs'
import { Provider } from '@aws-cdk/custom-resources'
import { join } from 'path';
import { Bucket } from '@aws-cdk/aws-s3';
import { CockroachDBSQLStatement } from './cockroachDbRunSQLProvider';
import { CockroachDBCluster } from './index';
import { CockroachDatabase } from './cockroachDatabase';

const COCKROACHDB_CRD_URL = 'https://raw.githubusercontent.com/cockroachdb/cockroach-operator/v2.4.0/install/crds.yaml';
const COCKROACHDB_OPERATOR_MANIFEST_URL = 'https://raw.githubusercontent.com/cockroachdb/cockroach-operator/v2.4.0/install/operator.yaml';

export class CockroachDBEKSCluster extends Construct implements CockroachDBCluster {
  public readonly endpoint: string;
  public readonly kubeCluster: Cluster
  private readonly clusterConfigDeployment: KubernetesManifest
  private readonly dbInitResource: Construct;
  public readonly rootSecret: Secret;
  public readonly rootCertificatesSecret: ISecret;
  private readonly options: CockroachDBClusterConfig;
  public readonly vpc: IVpc;

  public clusterAccessRole = new Role(this, 'cockroachdb-cluster-access-role', {
    assumedBy: new AnyPrincipal(),
  });

  private addClusterCapacity(cluster: Cluster, options: CockroachDBClusterConfig) {
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
      options.s3ReadBuckets?.forEach(bucket => bucket.grantRead(nodegroup.role))
      options.s3WriteBuckets?.forEach(bucket => bucket.grantWrite(nodegroup.role))

      nodegroups.push(nodegroup);
    })
    return nodegroups;
  }

  private addCockroachControlResources(cluster: Cluster) {
    const cockroachOperatorManifest = loadAll(request('GET', COCKROACHDB_OPERATOR_MANIFEST_URL).body.toString())
    const cockroachCRD = load(request('GET', COCKROACHDB_CRD_URL).body.toString());

    return cluster.addManifest('cockroachdb-control-manifest', cockroachCRD, ...cockroachOperatorManifest);
  }

  private configureVpcNetworking(cluster: Cluster) {
    return new CfnAddon(this, 'vpc-cni', {
      clusterName: cluster.clusterName,
      addonName: "vpc-cni",
      resolveConflicts: 'OVERWRITE',
    })
  }

  private configureStorage(cluster: Cluster) {
    const addon = new CfnAddon(this, 'ebs-csi', {
      clusterName: cluster.clusterName,
      addonName: 'aws-ebs-csi-driver',
      resolveConflicts: 'OVERWRITE'
    })
    const storageClass = cluster.addManifest('gp3-storage', {
      "allowVolumeExpansion": true,
      "apiVersion": "storage.k8s.io/v1",
      "kind": "StorageClass",
      "metadata": {
        "annotations": {
          "storageclass.kubernetes.io/is-default-class": "true"
        },
        "name": "gp3",
      },
      "parameters": {
        "type": "gp3"
      },
      "provisioner": "ebs.csi.aws.com",
      "reclaimPolicy": "Delete",
      "volumeBindingMode": "WaitForFirstConsumer"
    })
    storageClass.node.addDependency(addon);
    return storageClass;
  }

  private validateOptions(options: CockroachDBClusterConfig) {
    if (options.desiredNodes <= 3) {
      throw new Error("desiredNodes must be greater than or equal to 3")
    }
  }

  constructor(scope: Construct, id: string, options: CockroachDBClusterConfig) {
    super(scope, id);

    this.validateOptions(options);

    this.options = {
      ...CockroachDBClusterDefaults,
      ...options
    }

    this.kubeCluster = new Cluster(this, 'cockroach-cluster', {
      version: KubernetesVersion.V1_21,
      defaultCapacity: 0,
      vpc: this.options.vpc,
      vpcSubnets: this.options.vpcSubnets,
      endpointAccess: this.options.kubeEndpointPublic ? EndpointAccess.PUBLIC_AND_PRIVATE : EndpointAccess.PRIVATE,
      albController: {version: AlbControllerVersion.V2_3_0},
    })

    this.vpc = this.kubeCluster.vpc;
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
          "service.beta.kubernetes.io/aws-load-balancer-type": "external",
          "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
          "service.beta.kubernetes.io/aws-load-balancer-attributes": "load_balancing.cross_zone.enabled=true",
          "service.beta.kubernetes.io/aws-load-balancer-scheme": this.options.publiclyAvailable ? "internet-facing" : "internal"
        }
      },
      spec: {
        type: 'LoadBalancer',
        ports: [{port: 26257, targetPort: 26257, protocol: 'TCP'}],
        selector: {"crdb": "cockroach-cluster"}
      }
    }


    const vpcNetworking = this.configureVpcNetworking(this.kubeCluster);

    const storageSetup = this.configureStorage(this.kubeCluster);
    const operator = this.addCockroachControlResources(this.kubeCluster);

    this.clusterConfigDeployment = this.kubeCluster.addManifest('cockroachdb-cluster-manifest', cockroachCluster)

    const loadBalancer = this.kubeCluster.addManifest('cockroachdb-lb', loadBalancerManifest)

    this.clusterConfigDeployment.node.addDependency(...nodeGroup, operator, storageSetup, vpcNetworking)

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
    this.endpoint = lbAddressObjectValue.value;
    const initialization = this.dbInit(this.kubeCluster, options.rootUsername,this.rootCertificatesSecret)
    this.rootSecret = initialization.rootSecret;
    this.dbInitResource = initialization.dbInitResource;
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

  public runSql(id: string, upQuery: string, downQuery: string): CockroachDBSQLStatement {
    const statement = new CockroachDBSQLStatement(this, id, {
      cluster: this,
      database: "defaultdb",
      upQuery, downQuery
    })
    statement.node.addDependency(this.dbInitResource)
    return statement;
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

  public addDatabase(id: string, database: string, removalPolicy: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY = RemovalPolicy.RETAIN): CockroachDatabase {
    return new CockroachDatabase(this, id, {
      cluster: this,
      database,
      removalPolicy
    })
  }

  private dbInit(cluster: Cluster, username: string, rootCertSecret: ISecret) {
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
      vpcSubnets: cluster.kubectlPrivateSubnets ? {subnets: cluster.kubectlPrivateSubnets} : undefined,
    });

    const secretData: Omit<CockroachDBUserSecret, 'password'> = {
      isAdmin: true,
      username,
      endpoint: this.endpoint,
      port: 26257,
      options: ""
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
      }
    })

    dbInitResource.node.addDependency(this.clusterConfigDeployment, secret)
    return {
      rootSecret: secret,
      dbInitResource
    };
  }
}

const CockroachDBClusterDefaults: Omit<CockroachDBClusterConfig, 'vpc' | 'database' | 'rootUsername'> = {
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
  cockroachImage: "cockroachdb/cockroach:v21.2.2",
  publiclyAvailable: false,
  storageRequest: 50,
}

export interface CockroachDBClusterConfig {
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
}

export interface CockroachDBUserSecret {
  username: string;
  password: string;
  endpoint: string;
  isAdmin: boolean;
  port: number;
  options: string;
}

export interface CockroachDBRootCertificateSecret {
  caCrt: string;
  rootCrt: string;
  rootKey: string;
}
