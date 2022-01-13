#!/bin/bash

getTerminationStatus() {
  CONTAINER_INSTANCE=$(aws ecs describe-tasks --tasks $TASK_ARN --cluster $CLUSTER --region $AWS_REGION | jq -r .tasks[0].containerInstanceArn)
  INSTANCE_ID=$(aws ecs describe-container-instances --container-instances $CONTAINER_INSTANCE --cluster $CLUSTER --region $AWS_REGION | jq -r .containerInstances[0].ec2InstanceId)
  STATE=$(aws autoscaling describe-auto-scaling-instances --instance-ids $INSTANCE_ID --region $AWS_REGION | jq -r .AutoScalingInstances[0].LifecycleState)
  if [[ "$STATE" == *"Terminat"* ]]; then
    echo "true"
  else
    echo "false"
  fi
}

_decommission() {
  # Wait for a bit to make sure we get the decommission signal if needed
  TERMINATION_STATUS="$(getTerminationStatus)"

  echo "Received SIGTERM, draining node"
  /cockroach/cockroach node drain "${DECOMMISSION_FLAGS[@]}"

  echo "Drain complete, checking termination status"
  echo "Termination status: $TERMINATION_STATUS"
  if [[ "$TERMINATION_STATUS" == "true" ]]; then
    echo "Waiting for in-progress decommission operation"
    /cockroach/cockroach node decommission --self "${DECOMMISSION_FLAGS[@]}"
  fi
  kill -TERM "$COCKROACH_PID" 2>/dev/null
  echo "Node offline"
}

# Copy certificates to certs dir
mkdir certs
echo "$COCKROACH_CA_CRT" >> certs/ca.crt
echo "$COCKROACH_NODE_CRT" >> certs/node.crt
echo "$COCKROACH_NODE_KEY" >> certs/node.key
echo "$COCKROACH_ROOT_CRT" >> certs/client.root.crt
echo "$COCKROACH_ROOT_KEY" >> certs/client.root.key
chmod 600 certs/*

# Copy flags needed to decommission the node
args=($@)
DECOMMISSION_FLAGS=("--certs-dir=certs")
for i in "$@"; do
  case $i in
    --insecure)
      DECOMMISSION_FLAGS+=("$i")
      shift # past argument=value
      ;;
    --cluster-name=*)
      DECOMMISSION_FLAGS+=("$i")
      shift # past argument=value
      ;;
    --listen-addr=*)
      DECOMMISSION_FLAGS+=("--host=${i#*=}")
      shift
      ;;
  esac
done

echo "Will decommission node with flags:"
echo "${DECOMMISSION_FLAGS[@]}"

# Get storage drives
AVAILABLE_DRIVES=$(ls -1a drives/*/available | sed 's/\/available$//')
for DRIVE in $AVAILABLE_DRIVES; do
  echo "Adding store for drive: $DRIVE"
  args+=("--store=$DRIVE")
done

# Get instance metadata
METADATA=$(curl "$ECS_CONTAINER_METADATA_URI_V4/task")
ZONE=$(echo "$METADATA" | jq -r .AvailabilityZone)
TASK_ARN=$(echo "$METADATA" | jq -r .TaskARN)
CLUSTER=$(echo "$METADATA" | jq -r .Cluster)

LOCALITY="region=${AWS_REGION},zone=${ZONE}"

# Get hostnames for peers
PEERS="cockroach.db.crdb.com,cockroach.db.crdb.com"
DNSRES=""

# Wait for at least two peers
while [ $(echo "$DNSRES" | wc -l) -lt $MIN_PEERS ]
do
  DNSRES=$(dig +short @10.0.0.2 "$COCKROACH_DOMAIN" SRV)
  echo "$DNSRES"
  PEERS=$(echo "$DNSRES" | sed 's/\.$//' | awk '{printf "%s:%s,",$4,$3}' | sed 's/,$//')
done

echo "$PEERS"

args+=("--join=$PEERS" "--certs-dir=certs" "--locality=${LOCALITY}" "--log-config-file=/cockroach/log.yaml")
echo "Starting cockroach with flags:"
echo "${args[@]}"
/cockroach/cockroach "${args[@]}" &
COCKROACH_PID=$!
trap _decommission SIGTERM
wait "$COCKROACH_PID"


