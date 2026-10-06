FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime

WORKDIR /app

# hadolint ignore=DL3018
RUN apk add --no-cache postgresql-client \
  && mkdir -p /app/logs \
  && chown node:node /app/logs

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json monitor.js ./

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const http=require('http');const req=http.get('http://127.0.0.1:3001/health',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));"]

CMD ["node", "monitor.js"]
