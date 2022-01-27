#!/usr/bin/env bash

# Exit immediately on failure
set -ex

if [[ "$BOTTLEROCKET_INSTANCE" == true ]]; then
  echo "Running in Bottlerocket container"
  DISK_BASE="/.bottlerocket/rootfs/dev"
  BASE_MOUNT_POINT="/.bottlerocket/rootfs/mnt"
  PARTITION_CREATED_BASE="/.bottlerocket/bootstrap-containers/current/created"
else
  echo "Running in script"
  DISK_BASE="/dev"
  BASE_MOUNT_POINT="/mnt"
  PARTITION_CREATED_BASE="/ecs/mounts/markers"
fi

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

  if [[ "$BOTTLEROCKET_INSTANCE" == true ]]; then
      mount -o noatime,nodiratime,nobarrier $DISK $MOUNT_PATH
  else
      FSTAB_LINE="$DISK   $MOUNT_PATH   ext4   defaults,noatime,nodiratime,nobarrier,errors=remount-ro   0   2"
      echo "$FSTAB_LINE" >> /etc/fstab
      mount $MOUNT_PATH
  fi

  touch $MOUNT_PATH/available
  DISK_NUMBER=$((DISK_NUMBER+1))
  echo "Mounted $DRIVE to $MOUNT_PATH"
done
