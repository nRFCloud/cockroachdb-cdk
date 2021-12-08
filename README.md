# Cockroach CDK
CDK constructs for provisioning CockroachDB clusters

## CockroachDBEKSCluster
A cockroach cluster that runs on EKS using spot instances.

Features:
* Spot instance capacity, very cheap compute
* gp3 persistent volumes
* High availability over multiple AZs
* Automated S3 backups
* Provisions users with credentials stored in secrets manager
* Can be deployed as publicly available or VPC isolated
* Run arbitrary SQL as Cloudformation resources

## CockroachDBServerlessBridge
A wrapper for managing CockroachDB serverless with cloudformation

Features:
* Run SQL as cloudformation
* Provision users and databases as cloudformation
