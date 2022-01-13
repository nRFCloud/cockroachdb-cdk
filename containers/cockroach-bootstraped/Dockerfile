ARG COCKROACH_IMAGE=cockroachdb/cockroach:v21.2.2
FROM $COCKROACH_IMAGE

RUN microdnf install bind-utils jq python3-pip \
    && pip3 install awscli

COPY bootstrap.sh /cockroach/bootstrap.sh
COPY log.yaml /cockroach/log.yaml
RUN chmod 700 bootstrap.sh

ENTRYPOINT ["/cockroach/bootstrap.sh"]
