# converter.platform@agentmesh.ai in one container. It dials out to the mesh
# and needs no inbound traffic; the small HTTP answer on $PORT is only for
# Cloud Run's health check. No key or credential is in the image: the
# credential bundle is mounted from Secret Manager at run time
# (AGENTMESH_CREDENTIALS_FILE).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lib.mjs agent.mjs ./
USER node
CMD ["node", "agent.mjs"]
