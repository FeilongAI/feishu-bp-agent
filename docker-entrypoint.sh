#!/bin/sh
set -eu

if [ "${RUN_LARK_CONSUMER:-false}" = "true" ] && ! command -v "${LARK_CLI_BIN:-lark-cli}" >/dev/null 2>&1; then
  echo "RUN_LARK_CONSUMER=true but ${LARK_CLI_BIN:-lark-cli} is not installed in the image" >&2
  echo "Install lark-cli in the image or run the consumer outside the container and POST normalized events to /api/messages" >&2
  exit 1
fi

exec node --experimental-strip-types src/index.ts
