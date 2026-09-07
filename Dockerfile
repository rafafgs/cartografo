# The official image of the control plane and the screen (D23, t250).
#
# D23 says the control plane and the screen have an image and the runner does
# not: the runner needs the authenticated engine CLI and the target repository
# on the machine it runs on, and putting it here would only mean carrying both
# of those in too. So this image ships the single `cartografo` package — all six
# commands, one tarball (t248) — and `compose.yml` runs two containers from it,
# one per process. `cartografo-runner` stays a command an operator types on the
# host, pointed at the container's published port.
#
# Node is pinned to the exact version in `.nvmrc` rather than to a floating
# `:24-slim`: the image should track the version the rest of the project targets,
# not whatever the tag resolved to on the day somebody built it.

# ---------------------------------------------------------------------------
# Stage 1 — pack: the same tarball `npm pack` produces on a developer's machine
# ---------------------------------------------------------------------------
#
# Nothing is installed globally here and nothing from this stage reaches the
# final image except the tarball itself. `npm pack --workspace cartografo` is
# character for character the command `packages/core/test/pack-install.e2e.test.ts`
# already runs, which is the point: the artifact the image installs is the
# artifact that suite proves works from an empty directory.
#
# `--ignore-scripts` on the install, and only on the install: the pack stage has
# no use for a compiled `better-sqlite3` — it never opens a database — and
# building one would mean carrying a C++ toolchain in a stage whose whole output
# is a `.tgz`. `npm pack` runs its own `prepack`
# (`scripts/link-bundled-siblings.mjs`, which is what puts the five siblings
# where npm can bundle them) unaffected by that flag.
FROM node:24.19-slim AS pack

WORKDIR /src
COPY . .
RUN mkdir -p /tmp/pack \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && npm pack --workspace cartografo --pack-destination /tmp/pack

# ---------------------------------------------------------------------------
# Stage 2 — runtime: the tarball, installed the way a stranger installs it
# ---------------------------------------------------------------------------
FROM node:24.19-slim AS runtime

# The toolchain is installed, used and purged inside ONE layer, so the shipped
# image carries the compiled `.node` binary and not the compiler that produced
# it. `better-sqlite3` publishes prebuilt binaries, but not for every
# base-image/Node combination and not forever, and an image that only builds
# while a prebuild happens to exist is an image that breaks on a quiet upstream
# change.
COPY --from=pack /tmp/pack/*.tgz /tmp/pack/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install -g /tmp/pack/*.tgz --no-audit --no-fund \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/* /tmp/pack \
 && npm cache clean --force

# Somewhere to be that is not `/`. Nothing is written here — the database is at
# `/data` — but a relative path a subcommand computes should not land in the
# root directory.
WORKDIR /srv

# The database goes on the volume, never on the container's writable layer: at
# `/data/cartografo.db` and not at `/data`, because `CARTOGRAFO_DB_PATH` is a
# FILE path (`packages/core/src/db/connection.ts`) and WAL leaves `-wal`/`-shm`
# siblings beside it.
ENV CARTOGRAFO_DB_PATH=/data/cartografo.db
VOLUME /data

# Deliberately no `ENV CARTOGRAFO_HOST` and no `ENV CARTOGRAFO_SCREEN_HOST`
# anywhere above: the image inherits the loopback defaults the code itself
# chooses (`packages/core/src/index.ts`, `packages/screen/src/server.ts`), for
# the reason written there — a tool that starts listening on the network because
# somebody ran it would be taking a decision that belongs to its operator.
# Opening the address is done once, in `compose.yml`, where it can be read.
# `EXPOSE` documents the two ports; it opens nothing by itself.
EXPOSE 4317 4318

# Node's own `fetch`, so no `curl` has to be added to the image for the sake of
# one probe. `CARTOGRAFO_PORT` is read at probe time because a container may have
# been started on another port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.CARTOGRAFO_PORT || 4317) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The control plane alone — the same three flags `pack-install.e2e.test.ts`
# calls `CONTROL_PLANE_ONLY`. `CMD` and not `ENTRYPOINT`: the screen is the same
# image with a different process, and `compose.yml` replaces the whole command
# with one `command:` key.
CMD ["cartografo", "--no-runner", "--no-browser", "--no-screen"]
