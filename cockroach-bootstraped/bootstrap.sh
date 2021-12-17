#!/bin/bash

_decomission() {
  echo "Received SIGTERM, decommissioning node"
  /cockroach/cockroach node drain --drain-wait=60s "${DECOMISSION_FLAGS[@]}" &
  /cockroach/cockroach node decommission --self "${DECOMISSION_FLAGS[@]}"
  echo "Node decommissioned, terminating"
  kill -TERM "$COCKROACH_PID" 2>/dev/null
}

# Copy certificates to certs dir
mkdir certs
echo "$COCKROACH_CA_CRT" >> certs/ca.crt
echo "$COCKROACH_NODE_CRT" >> certs/node.crt
echo "$COCKROACH_NODE_KEY" >> certs/node.key
echo "$COCKROACH_ROOT_CRT" >> certs/client.root.crt
echo "$COCKROACH_ROOT_KEY" >> certs/client.root.key

# Copy flags needed to decommission the node
args=($@)
DECOMISSION_FLAGS=("--certs-dir=certs")
for i in "$@"; do
  case $i in
    --insecure)
      DECOMISSION_FLAGS+=("$i")
      shift # past argument=value
      ;;
    --cluster-name=*)
      DECOMISSION_FLAGS+=("$i")
      shift # past argument=value
      ;;
    --listen-addr=*)
      DECOMISSION_FLAGS+=("--host=${i#*=}")
      shift
      ;;
  esac
done

echo "Will decommission node with flags:"
echo "${DECOMISSION_FLAGS[@]}"

# Get instance metadata
METADATA=$(curl "$ECS_CONTAINER_METADATA_URI_V4/task")
ZONE=$(echo "$METADATA" | jq -r .AvailabilityZone)

LOCALITY="region=${AWS_REGION},zone=${ZONE}"

# Get hostnames for peers
PEERS="cockroach.db.crdb.com,cockroach.db.crdb.com"
DNSRES=""

# Wait for at least two peers
while [ $(echo "$DNSRES" | wc -l) -lt 2 ]
do
  DNSRES=$(dig +short @10.0.0.2 "$COCKROACH_DOMAIN" SRV)
  echo "$DNSRES"
  PEERS=$(echo "$DNSRES" | sed 's/\.$//' | awk '{printf "%s:%s,",$4,$3}' | sed 's/,$//')
  sleep 1
done

echo "$PEERS"

args+=("--join=$PEERS" "--certs-dir=certs" "--locality=${LOCALITY}")
echo "Starting cockroach with flags:"
echo "${args[@]}"
/cockroach/cockroach "${args[@]}" &
COCKROACH_PID=$!
trap _decomission SIGTERM
wait "$COCKROACH_PID"


