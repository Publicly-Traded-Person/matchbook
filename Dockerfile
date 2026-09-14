FROM oven/bun:1

WORKDIR /app

# Dependencies first, so a code change does not reinstall them. The lockfile is
# optional: a fresh clone that has never run `bun install` has no bun.lock yet.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

# config.toml and data/ are bind mounts from the host (see docker-compose.yml),
# not baked into the image.
CMD ["bun", "run", "src/main.ts"]
