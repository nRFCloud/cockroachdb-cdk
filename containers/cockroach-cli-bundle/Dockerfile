ARG COCKROACH_IMAGE=cockroachdb/cockroach:v21.2.2
FROM $COCKROACH_IMAGE

RUN mkdir -p /build/bin \
    && cp /cockroach/cockroach /build/bin
WORKDIR /
ENTRYPOINT [ "/bin/bash" ]
