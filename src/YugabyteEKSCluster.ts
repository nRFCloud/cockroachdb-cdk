import { Construct, Stack } from '@aws-cdk/core';
import { Cluster, FargateCluster, FargateProfile, KubernetesVersion } from '@aws-cdk/aws-eks';
import { InstanceClass, InstanceSize, InstanceType, SubnetSelection, Vpc } from '@aws-cdk/aws-ec2';

const SIG_STORAGE_EKS_NVME_MANIFEST_URL = 'https://raw.githubusercontent.com/kubernetes-sigs/sig-storage-local-static-provisioner/master/helm/generated_examples/eks-nvme-ssd.yaml';

export class YugabyteEKSCluster extends Construct {
  constructor(stack: Stack, id: string, options: {
    vpc?: Vpc,
    vpcSubnets?: SubnetSelection[]
  }) {
    super(stack, id);

    const kubeCluster = new FargateCluster(this, 'yugabyte-cluster', {
      version: KubernetesVersion.V1_21,
      vpc: options.vpc,
      vpcSubnets: options.vpcSubnets,
    })

    const capacity = kubeCluster.addFargateProfile('fargate-capacity', {
      selectors: [{
        namespace: 'yb-cluster'
      }],
    })

    const storageConfig = kubeCluster.addManifest('storage-config', ...kubeCluster.vpc.availabilityZones.map(this.generateStorageConfig));
    const chartDeployments = [];

    for (let i = 0; i < kubeCluster.vpc.availabilityZones.length; i++) {
      const az = kubeCluster.vpc.availabilityZones[i]
      const deployment = kubeCluster.addHelmChart(`yugabyte-cluster-${i}`, {
        repository: "https://charts.yugabyte.com",
        chart: "yugabyte",
        createNamespace: true,
        version: '2.11.0',
        namespace: `yb-cluster`,
        release: `yb-cluster-${az}-release`,
        wait: true,
        values: {
          "isMultiAz": true,
          "AZ": az,
          "masterAddresses": kubeCluster.vpc.availabilityZones.map((az) => `yb-cluster-${az}-release-yugabyte-yb-master-0.yb-cluster-${az}-release-yugabyte-yb-masters.yb-cluster.svc.cluster.local:7100`).join(','),
          "storage": {
            ephemeral: true,
            "master": {
              "storageClass": `standard-${az}`,
            },
            "tserver": {
              "storageClass": `standard-${az}`,
            }
          },
          resource: {
            master: {
              requests: {
                cpu: 0.3,
                memory: "1Gi"
              },
              limits: {
                cpu: 1,
                memory: "1Gi"
              }
            },
            tserver: {
              requests: {
                cpu: 2,
                memory: "8Gi"
              },
              limits: {
                memory: "8Gi"
              }
            }
          },
          enableLoadBalancer: false,
          serviceEndpoints: [],
          "replicas": {
            "master": 1,
            "tserver": 1,
            "totalMasters": 3
          },
          "gflags": {
            "master": {
              default_memory_limit_to_ram_ratio: 0.2,
              "placement_cloud": "aws",
              "placement_region": "us-east-1",
              "placement_zone": az
            },
            "tserver": {
              default_memory_limit_to_ram_ratio: 0.4,
              "placement_cloud": "aws",
              "placement_region": "us-east-1",
              "placement_zone": az
            }
          },
          oldNamingStyle: false,
          // authCredentials: i === kubeCluster.vpc.availabilityZones.length - 1 ? {
          //   ysql: {
          //     password: "test",
          //   },
          //   ycql: {
          //     password: "test_cql",
          //   }
          // } : undefined
        }
      });

      deployment.node.addDependency(capacity, storageConfig, ...chartDeployments)
      chartDeployments.push(deployment);
    }

    kubeCluster.addManifest('yugabyte-lb', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        namespace: "yb-cluster",
        name: "yugabyte-lb", annotations: {
          "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
          "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip"
        }
      },
      spec: {
        type: 'LoadBalancer',
        ports: [{port: 5433, targetPort: 5433, protocol: 'TCP'}],
        selector: {"app.kubernetes.io/name": "yb-tserver"}
      }
    }).node.addDependency(...chartDeployments)
  }

  private generateStorageConfig(az: string) {
    return {
      kind: "StorageClass",
      apiVersion: "storage.k8s.io/v1",
      metadata: {
        name: `standard-${az}`
      },
      provisioner: "kubernetes.io/aws-ebs",
      parameters: {
        type: "gp2",
        zone: az
      }
    }
  }
}
