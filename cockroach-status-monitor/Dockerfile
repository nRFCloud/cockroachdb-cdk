FROM cockroachdb/cockroach:v21.2.2

RUN microdnf install jq python3-pip curl \
    && pip3 install awscli

COPY monitor.sh /monitor.sh
RUN chmod 700 /monitor.sh

ENTRYPOINT ["/monitor.sh"]
