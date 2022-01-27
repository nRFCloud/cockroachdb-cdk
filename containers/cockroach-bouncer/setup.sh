#!/usr/bin/env bash

export PGBOUNCER_CLIENT_TLS_SSLMODE=require
export PGBOUNCER_CLIENT_TLS_CA_FILE=/certs/ca.crt
export PGBOUNCER_CLIENT_TLS_CERT_FILE=/certs/server.crt
export PGBOUNCER_CLIENT_TLS_KEY_FILE=/certs/server.key
export PGBOUNCER_SERVER_TLS_CA_FILE=/certs/ca.crt

CORE_COUNT=$(getconf _NPROCESSORS_ONLN)
MAX_DB_CON=$((CORE_COUNT * 4))

export PGBOUNCER_MAX_DB_CONNECTIONS=$MAX_DB_CON
export PGBOUNCER_DEFAULT_POOL_SIZE=$MAX_DB_CON
export PGBOUNCER_MIN_POOL_SIZE=$MAX_DB_CON

echo "$CA_CRT" > $PGBOUNCER_CLIENT_TLS_CA_FILE
echo "$SERVER_CRT" > $PGBOUNCER_CLIENT_TLS_CERT_FILE
echo "$SERVER_KEY" > $PGBOUNCER_CLIENT_TLS_KEY_FILE

exec "/opt/bitnami/scripts/pgbouncer/entrypoint.sh" "/opt/bitnami/scripts/pgbouncer/run.sh"
