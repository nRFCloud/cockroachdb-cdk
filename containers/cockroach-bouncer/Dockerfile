FROM ubuntu as builder

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get -y install make libevent-dev pkg-config libssl-dev libc-ares-dev libtool git

# Use patched version that respect check query errors
RUN git clone https://github.com/jfrconley/pgbouncer.git /pgbouncer

WORKDIR /pgbouncer

RUN git submodule init \
    && git submodule update

RUN ./autogen.sh \
    && ./configure \
    && make build_pgbouncer

FROM ubuntu:22.04
RUN mkdir /pgbouncer \
    && apt-get update \
    && apt-get install -y gettext libevent-2.1-7 libssl1.1 libc-ares2
WORKDIR /pgbouncer
COPY --from=builder /pgbouncer/pgbouncer /pgbouncer/pgbouncer
COPY pgbouncer.ini /pgbouncer/pgbouncer.temp.ini
COPY setup.sh /pgbouncer/setup.sh

RUN groupadd -r pgbouncer \
    && useradd -r -g pgbouncer pgbouncer \
    && chown -R pgbouncer /pgbouncer

USER pgbouncer

ENTRYPOINT  ["/pgbouncer/setup.sh"]
