FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/conversation/package.json packages/conversation/tsconfig.json packages/conversation/
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/

RUN pnpm install --frozen-lockfile

COPY packages/protocol/src packages/protocol/src
COPY packages/conversation/src packages/conversation/src
COPY packages/gateway/src packages/gateway/src
COPY packages/agent/src packages/agent/src

RUN pnpm -r run build

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.1 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/packages/conversation/package.json packages/conversation/
COPY --from=builder /app/packages/conversation/dist packages/conversation/dist
COPY --from=builder /app/packages/gateway/package.json packages/gateway/
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist
COPY --from=builder /app/packages/agent/package.json packages/agent/

RUN pnpm install --frozen-lockfile --prod

ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/gateway/dist/server.js"]
