# tfv server: pull request automation for Terraform, OpenTofu and Terragrunt.
# Tool binaries are downloaded on demand (checksum-verified) into /data.
FROM node:26-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --home-dir /home/tfv tfv \
 && mkdir -p /data && chown tfv:tfv /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/web packages/server/web

ENV NODE_ENV=production \
    TFV_DATA_DIR=/data \
    TFV_PORT=8080 \
    TFV_REQUIRE_APPLY_PROJECT=false \
    TFV_ACK_REACTION=eyes \
    TFV_PROGRESS_REPLY=true \
    TFV_COMMENT_MODE=new \
    TFV_DRIFT=true \
    NODE_NO_WARNINGS=1

USER 10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TFV_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/src/main.ts"]
