FROM alpine

RUN apk add e2fsprogs bash lsblk
ADD setup.sh ./
RUN chmod +x ./setup.sh
ENTRYPOINT ["sh", "setup.sh"]
