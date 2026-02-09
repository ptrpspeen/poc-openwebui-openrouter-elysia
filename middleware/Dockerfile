FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json .
RUN bun install --frozen-lockfile || bun install

COPY src ./src

EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
