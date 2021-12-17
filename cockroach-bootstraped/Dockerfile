ARG COCKROACH_IMAGE=cockroachdb/cockroach:v21.2.2
FROM $COCKROACH_IMAGE

RUN microdnf install bind-utils jq
COPY bootstrap.sh /cockroach/bootstrap.sh
RUN chmod 700 bootstrap.sh

ENTRYPOINT ["/cockroach/bootstrap.sh"]
