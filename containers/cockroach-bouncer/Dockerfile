FROM public.ecr.aws/bitnami/pgbouncer:1.16.1

COPY setup.sh /opt/bitnami/scripts/pgbouncer/wrapper.sh
COPY require-ssl.sh /docker-entrypoint-initdb.d

USER root
# Allow the certs directory to be written to
RUN mkdir /certs \
    && chmod -R 777 /certs
USER 1001

ENTRYPOINT ["/opt/bitnami/scripts/pgbouncer/wrapper.sh"]
