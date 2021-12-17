FROM alpine

RUN apk add e2fsprogs bash parted lsblk
ADD setup.sh ./
RUN chmod +x ./setup.sh
ENTRYPOINT ["sh", "setup.sh"]
