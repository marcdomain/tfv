# teriac server: pull request automation for Terraform, OpenTofu and Terragrunt.
# Tool binaries are downloaded on demand (checksum-verified) into /data.
FROM node:26-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# rclone uploads and restores database backups (S3, GCS, Azure). Pinned, and checked against
# checksums from rclone's SHA256SUMS for v1.76.0, whose signature (key FBF737EC...FF3B54FA,
# https://rclone.org/downloads/) was verified when they were copied here.
FROM debian:trixie-slim AS rclone
ARG TARGETARCH
ARG RCLONE_VERSION=1.76.0
ARG RCLONE_SHA256_amd64=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7
ARG RCLONE_SHA256_arm64=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in amd64) sum="$RCLONE_SHA256_amd64" ;; arm64) sum="$RCLONE_SHA256_arm64" ;; *) echo "no rclone for $TARGETARCH"; exit 1 ;; esac; \
    zip="rclone-v${RCLONE_VERSION}-linux-${TARGETARCH:-amd64}.zip"; \
    curl -fsSLo "/tmp/$zip" "https://downloads.rclone.org/v${RCLONE_VERSION}/$zip"; \
    echo "$sum  /tmp/$zip" | sha256sum -c -; \
    unzip -q "/tmp/$zip" -d /tmp/rclone; \
    install -m 0755 /tmp/rclone/*/rclone /usr/local/bin/rclone; \
    /usr/local/bin/rclone version | head -1

FROM node:26-trixie-slim
# Security updates released since the base image was built, and git for clones and Terraform
# module sources (over https).
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --home-dir /home/teriac teriac \
 && mkdir -p /data && chown teriac:teriac /data
# Remove what nothing in a running server uses, so its CVEs go too: npm and corepack (bundled
# with Node), perl and git's manual (git needs them only for a few rarely used commands),
# expat (only `git http-push`), login and account tools, mount and disk utilities, systemd
# and udev libraries, the ncurses tools, the openssl command, and apt and its database
# tools. git, node, rclone, tini, sh and bash, and the libraries they load, stay.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && dpkg --purge --force-remove-essential --force-remove-protected --force-depends \
      apt libapt-pkg7.0 \
      git-man liberror-perl perl perl-modules-5.40 libperl5.40 libexpat1 \
      login passwd login.defs libpam-modules libpam-modules-bin libpam-runtime libpam0g \
      util-linux mount bsdutils libmount1 libblkid1 libsmartcols1 libuuid1 liblastlog2-2 libsqlite3-0 \
      libsystemd0 libudev1 sysvinit-utils ncurses-bin ncurses-base openssl openssl-provider-legacy \
 && dpkg --purge --force-remove-essential --force-remove-protected --force-depends perl-base \
 && rm -rf /var/cache/debconf/* /var/log/* /usr/share/doc/* /usr/share/man/* \
 && for b in /usr/local/bin/node /usr/bin/git /usr/lib/git-core/git-remote-https /usr/bin/tini /bin/sh /bin/bash \
             /bin/ls /bin/cp /bin/mv /bin/sed /bin/grep /bin/tar /bin/gzip /usr/bin/find /usr/bin/env; do \
      if ldd "$b" | grep -q "not found"; then echo "$b is missing a library:"; ldd "$b" | grep "not found"; exit 1; fi; \
    done
WORKDIR /app
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/web packages/server/web

# Settings default in the code (data in /data, port 8080, ...); set TERIAC_* to change them.
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1

USER 10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TERIAC_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/src/main.ts"]
