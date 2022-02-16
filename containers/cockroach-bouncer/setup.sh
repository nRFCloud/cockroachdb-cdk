#!/usr/bin/env bash

export PG_USER_root="password"

export PG_HOST=${PG_HOST:=localhost}
export PG_PORT=${PG_PORT:=26257}
export PG_POOL_SIZE=${PG_POOL_SIZE:=100}
export PGB_PORT=${PGB_PORT:=5432}
export PGB_VERBOSITY=${PGB_VERBOSITY:=0}
export PGB_MAX_CLIENT_CONN=${PGB_MAX_CLIENT_CONN:=999999}

mkdir certs
echo "$CA_CRT" > certs/ca.crt
echo "$SERVER_CRT" > certs/server.crt
echo "$SERVER_KEY" > certs/server.key

envsubst < pgbouncer.temp.ini > pgbouncer.ini

# Configure users
newline=$'\n'
pg_users=${!PG_USER_@}
userfile=$""
for i in $pg_users; do
  username=${i#"PG_USER_"}
  password=${!i}
  userfile+=$"\"$username\" \"${password}\"$newline"
done

echo "$userfile" > userfile.txt

exec ./pgbouncer pgbouncer.ini
