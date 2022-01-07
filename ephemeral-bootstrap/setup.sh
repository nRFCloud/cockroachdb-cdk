#!/usr/bin/env bash

# Exit immediately on failure
set -ex

DISK_BASE="/dev"
BASE_MOUNT_POINT="/ecs/mounts"
PARTITION_CREATED_BASE="/ecs/mounts/markers"
INSTANCE_DRIVES=$(lsblk -d --sort NAME --output NAME,MODEL -n | grep Instance | awk '{print $1}')
DISK_NUMBER=0

mkdir -p $PARTITION_CREATED_BASE

for DRIVE in $INSTANCE_DRIVES; do
  echo "Found instance store: ${DRIVE}"
  MOUNT_PATH="$BASE_MOUNT_POINT/drive$DISK_NUMBER"
  DISK="$DISK_BASE/$DRIVE"
  PARTITION_CREATED="$PARTITION_CREATED_BASE/$DRIVE"
  if [ ! -f $PARTITION_CREATED ]; then
    mkfs -t ext4 $DISK
    touch $PARTITION_CREATED
    echo "Partitioned ${DRIVE}"
  fi
  mkdir -p $MOUNT_PATH
  FSTAB_LINE="$DISK   $MOUNT_PATH   ext4   defaults,noatime,nodiratime,nobarrier,errors=remount-ro   0   2"
  echo "$FSTAB_LINE" >> /etc/fstab

  mount $MOUNT_PATH
  touch $MOUNT_PATH/available
  DISK_NUMBER=$((DISK_NUMBER+1))
  echo "Mounted $DRIVE to $MOUNT_PATH"
done
