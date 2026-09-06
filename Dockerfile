# syntax=docker/dockerfile:1

# Build image.
#
# Separate from the runtime image so that `typescript`, `tsup` and the rest of
# the devDependencies — none of which the service needs to answer a request —
# never reach what is deployed.
FROM node:22-bookworm-slim AS build

# `corepack enable` installs the shim, and Corepack reads the `packageManager`
# field in package.json, so the build compiles with the exact pnpm the lockfile
# was written with rather than with whatever version a `pnpm` install would
# happen to resolve.
RUN corepack enable

WORKDIR /app

# The manifest and lockfile are copied first and on their own, so that the
# dependency layer is only rebuilt when one of them changes. Editing a source
# file then reuses this layer instead of reinstalling.
COPY package.json pnpm-lock.yaml ./

# `--frozen-lockfile` is the difference between building the commit that was
# pushed and building something that merely satisfies the manifest: it refuses to
# resolve or write a lockfile, so a dependency that was added locally but not
# locked fails the build here rather than shipping an unreviewed version.
RUN pnpm install --frozen-lockfile

# The whole typechecked program is copied, not just `src`: `pnpm build` starts
# with `tsc --noEmit` and tsconfig includes the tests and the drizzle/vitest
# configs, so building without them would quietly check less than CI does.
COPY tsconfig.json vitest.config.ts drizzle.config.ts ./
COPY src ./src
COPY tests ./tests

RUN pnpm build


# Production dependencies only.
#
# Resolved fresh rather than pruned out of the build stage's tree: a prune has to
# name what to keep and is wrong the day a devDependency is renamed, whereas this
# install cannot contain one at all.
FROM node:22-bookworm-slim AS deps

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# `--ignore-scripts` means no dependency's install hook runs while the image is
# built. Nothing in the production set needs one, and a build step is the one
# place a compromised package gets to execute code as the builder.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts


FROM node:22-bookworm-slim AS runtime

# Tells Fastify to emit JSON logs and to stop treating itself as a development
# process. It is not a configuration value: everything the service reads is
# validated at startup by `src/lib/env.ts`.
ENV NODE_ENV=production

WORKDIR /app

# No `.env`, at any stage, and `.dockerignore` keeps one out of the build context
# even by accident. Configuration arrives through the environment; an image that
# carries a configuration file is an image that carries a credential.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The service never writes to disk and holds no custody, so it needs no
# privileges: running as the base image's unprivileged user means a compromised
# process does not own the container it is in.
USER node

# The port `src/lib/env.ts` defaults to when `PORT` is unset.
EXPOSE 3000

# `/health` is deliberately I/O-free (see `src/routes/health.ts`), so a failure
# here means the process is gone or wedged, not that a dependency is slow — which
# is exactly the question a container healthcheck should be asking.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
