FROM oven/bun:1.4@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock* ./
COPY --chown=bun:bun apps ./apps
COPY --chown=bun:bun packages ./packages
COPY --chown=bun:bun adapters ./adapters
COPY --chown=bun:bun services ./services
COPY --chown=bun:bun profiles ./profiles
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun config ./config
RUN chown bun:bun /app
USER bun
RUN bun install --frozen-lockfile
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
