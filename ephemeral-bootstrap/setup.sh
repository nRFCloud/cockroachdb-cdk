#!/usr/bin/env bash

# Exit immediately on failure
set -ex

DISK_BASE="/.bottlerocket/rootfs/dev"
BASE_MOUNT_POINT="/.bottlerocket/rootfs/mnt"
PARTITION_CREATED_BASE="/.bottlerocket/bootstrap-containers/current"
INSTANCE_DRIVES=$(lsblk -d --sort NAME --output NAME,MODEL -n | grep Instance | awk '{print $1}')
DISK_NUMBER=0

for DRIVE in $INSTANCE_DRIVES; do
  echo "Found instance store: ${DRIVE}"
  MOUNT_PATH="$BASE_MOUNT_POINT/drive$DISK_NUMBER"
  DISK="$DISK_BASE/$DRIVE"
  PARTITION_CREATED="$PARTITION_CREATED_BASE/$DRIVE"
  if [ ! -f $PARTITION_CREATED ]; then
    parted -s $DISK mklabel gpt 1>/dev/null
    parted -s $DISK mkpart primary ext4 0% 100% 1>/dev/null
    mkfs.ext4 -F ${DISK}p1
    touch $PARTITION_CREATED
    echo "Partitioned ${DRIVE}"
  fi
  mkdir -p $BASE_MOUNT_POINT/$DRIVE
  mount ${DISK}p1 $MOUNT_PATH
  touch $MOUNT_PATH/available
  DISK_NUMBER++
  echo "Mounted $DRIVE to $MOUNT_PATH"
done
