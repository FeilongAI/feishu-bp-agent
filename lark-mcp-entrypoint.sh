#!/bin/sh
set -eu

if [ -z "${APP_ID:-}" ] || [ -z "${APP_SECRET:-}" ]; then
  echo "APP_ID and APP_SECRET are required" >&2
  exit 1
fi

# The official CLI otherwise falls back to preset.default. Build the list from
# the installed package so upgrades automatically expose newly generated APIs.
if [ -z "${LARK_TOOLS:-}" ] || [ "${LARK_TOOLS}" = "all" ]; then
  LARK_TOOLS=$(node -e 'const { AllTools } = require("/usr/local/lib/node_modules/@larksuiteoapi/lark-mcp/dist/mcp-tool/tools"); process.stdout.write(AllTools.map((tool) => tool.name).join(","));')
  export LARK_TOOLS
fi

exec lark-mcp mcp "$@"
