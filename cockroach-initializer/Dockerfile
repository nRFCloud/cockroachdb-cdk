ARG COCKROACH_IMAGE=cockroachdb/cockroach:v21.2.2
FROM $COCKROACH_IMAGE

RUN microdnf install iproute bind-utils
COPY init.sh /cockroach/init.sh

WORKDIR /cockroach

ENTRYPOINT ["/cockroach/init.sh"]
