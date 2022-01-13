# Cockroach CDK
CDK constructs for provisioning CockroachDB clusters

## CockroachDBECSCluster
A cockroach cluster that runs on ECS using spot instances.

Features:
* Spot instance capacity, very cheap compute
* High availability over multiple AZs
* Automated S3 backups
* Provisions users with credentials stored in secrets manager
* Can be deployed as publicly available or VPC isolated
* Run arbitrary SQL as Cloudformation resources
* Rolling version and AMI updates
* Safe handling of rebalance and spot interruption notifications

## CockroachDBServerlessBridge
A wrapper for managing CockroachDB serverless with cloudformation

Features:
* Run SQL as cloudformation
* Provision users and databases as cloudformation
* Automatic S3 backups

