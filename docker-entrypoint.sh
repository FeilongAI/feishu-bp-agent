#!/bin/sh
set -eu

if [ "${REQUIRE_DATABASE_URL:-true}" = "true" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [ "${RUN_LARK_CONSUMER:-false}" = "true" ] && ! command -v "${LARK_CLI_BIN:-lark-cli}" >/dev/null 2>&1; then
  echo "RUN_LARK_CONSUMER=true but ${LARK_CLI_BIN:-lark-cli} is not installed in the image" >&2
  echo "Install lark-cli in the image or run the consumer outside the container and POST normalized events to /api/messages" >&2
  exit 1
fi

if [ -n "${DATABASE_URL:-}" ] && [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node --experimental-strip-types src/migrate.ts
fi

exec node --experimental-strip-types src/index.ts
