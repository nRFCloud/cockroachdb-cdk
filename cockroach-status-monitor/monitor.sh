#!/bin/bash

# Get instance metadata
METADATA=$(curl "$ECS_CONTAINER_METADATA_URI_V4/task")
TASK_ARN=$(echo "$METADATA" | jq -r .TaskARN)
CLUSTER=$(echo "$METADATA" | jq -r .Cluster)
DESIRED_STATUS=""

while [[ "$DESIRED_STATUS" != "STOPPED" ]]; do
  sleep 5
  DESIRED_STATUS="$(aws ecs describe-tasks --tasks="$TASK_ARN" --cluster="$CLUSTER" --region "$AWS_REGION" | jq -r ".tasks[0].desiredStatus")"
  echo "Current desired status: $DESIRED_STATUS"
done
