#!/bin/sh

set -eu

CONFIG=/tmp/element-web-config/config.json
ENABLED=${CFS_WEBPUSH_ENABLED:-false}

case "$ENABLED" in
    true|false) ;;
    *) echo "CFS_WEBPUSH_ENABLED must be true or false" >&2; exit 1 ;;
esac

if [ "$ENABLED" = "true" ]; then
    : "${CFS_WEBPUSH_GATEWAY_URL:?CFS_WEBPUSH_GATEWAY_URL is required}"
    : "${CFS_WEBPUSH_APPLICATION_SERVER_KEY:?CFS_WEBPUSH_APPLICATION_SERVER_KEY is required}"
    : "${CFS_WEBPUSH_APP_ID:?CFS_WEBPUSH_APP_ID is required}"
    case "$CFS_WEBPUSH_GATEWAY_URL" in
        https://*) ;;
        *) echo "CFS_WEBPUSH_GATEWAY_URL must use HTTPS" >&2; exit 1 ;;
    esac
    if [ "$CFS_WEBPUSH_APP_ID" != "com.collectorfigures.chat.web" ]; then
        echo "Unexpected CFS_WEBPUSH_APP_ID" >&2
        exit 1
    fi
fi

jq \
    --argjson enabled "$ENABLED" \
    --arg gateway "${CFS_WEBPUSH_GATEWAY_URL:-https://chat-push.collectorfigures.com}" \
    --arg key "${CFS_WEBPUSH_APPLICATION_SERVER_KEY:-}" \
    --arg app_id "${CFS_WEBPUSH_APP_ID:-com.collectorfigures.chat.web}" \
    '.cfs_webpush_enabled = $enabled
     | .cfs_webpush_gateway_url = $gateway
     | .cfs_webpush_application_server_key = $key
     | .cfs_webpush_app_id = $app_id' \
    "$CONFIG" | sponge "$CONFIG"

echo "Collector Figures Web Push runtime configuration rendered; public_key_logged=false"
