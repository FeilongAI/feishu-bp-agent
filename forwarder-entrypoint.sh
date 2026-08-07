#!/bin/sh
set -eu

umask 077

required_value() {
  name="$1"
  value="$2"
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    exit 1
  fi
  case "$value" in
    *change_me*|*replace_with*)
      echo "$name still contains an example placeholder" >&2
      exit 1
      ;;
  esac
}

required_value FEISHU_APP_ID "${FEISHU_APP_ID:-}"
required_value FEISHU_APP_SECRET "${FEISHU_APP_SECRET:-}"
required_value INGRESS_API_KEY "${INGRESS_API_KEY:-}"

mkdir -p "${HOME}/.lark-cli" "${FORWARDER_SPOOL_DIR:-/var/lib/feishu-bp-forwarder/spool}"

printf '%s\n' "$FEISHU_APP_SECRET" \
  | "${LARK_CLI_BIN:-lark-cli}" config init \
      --app-id "$FEISHU_APP_ID" \
      --app-secret-stdin \
      --brand "${FEISHU_BRAND:-feishu}"

exec node --experimental-strip-types src/forwarderMain.ts
