#!/bin/bash

mkdir certs
echo "$COCKROACH_CA_CRT" >> certs/ca.crt
echo "$COCKROACH_ROOT_CRT" >> certs/client.root.crt
echo "$COCKROACH_ROOT_KEY" >> certs/client.root.key

DNSRES=""

# Wait for at least two peers
while [ $(echo "$DNSRES" | wc -l) -lt 2 ]
do
  DNSRES=$(dig +short @10.0.0.2 "$COCKROACH_DOMAIN" SRV)
  echo "$DNSRES"
  sleep 1
done

INIT_STATUS=1
echo "Initializing cluster"
while [ $INIT_STATUS -ne 0 ]
do
  DNSRES=$(dig +short @10.0.0.2 "$COCKROACH_DOMAIN" SRV)
  echo "$DNSRES"
  PEER=$(echo "$DNSRES" | head -n1 | sed 's/\.$//' | awk '{printf "%s:%s,",$4,$3}' | sed 's/,$//')
  echo "Initializing cluster"
  args=("init" $@ "--url=postgres://root@$PEER" "--certs-dir=certs")
  echo "${args[@]}"
  /cockroach/cockroach "${args[@]}"
  INIT_STATUS=$?
  sleep 1
done
