FROM alpine

RUN apk add e2fsprogs bash lsblk
ADD setup.sh ./
RUN chmod +x ./setup.sh
ENV BOTTLEROCKET true
ENTRYPOINT ["sh", "setup.sh"]
