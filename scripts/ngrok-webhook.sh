#!/usr/bin/env bash
set -euo pipefail

PORT=${PORT:-3000}
WEBHOOK_PATH="/api/webhooks/email"

echo "Starting ngrok tunnel on port $PORT..."
echo "Webhook path: $WEBHOOK_PATH"
echo ""

# Start ngrok in background
ngrok http "$PORT" --log=stdout --log-format=json > /tmp/ngrok-telent.log 2>&1 &
NGROK_PID=$!

# Wait for tunnel to be established (poll ngrok local API)
echo "Waiting for tunnel..."
for i in $(seq 1 15); do
  sleep 1
  TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
    | grep -o '"public_url":"https://[^"]*"' \
    | head -1 \
    | sed 's/"public_url":"//' \
    | sed 's/"$//' || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Could not get tunnel URL after 15 seconds."
  echo "       Is ngrok installed? Run: brew install ngrok"
  echo "       Do you need to authenticate? Run: ngrok authtoken YOUR_TOKEN"
  kill "$NGROK_PID" 2>/dev/null || true
  exit 1
fi

# Attempt to read POSTMARK_WEBHOOK_TOKEN from .env file
POSTMARK_TOKEN=""
if [ -f .env ]; then
  POSTMARK_TOKEN=$(grep -E "^POSTMARK_WEBHOOK_TOKEN=" .env | cut -d '=' -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
fi

if [ -n "$POSTMARK_TOKEN" ]; then
  # Inject Basic Auth credentials natively into the URL (https://username:password@domain.com)
  WEBHOOK_URL=$(echo "$TUNNEL_URL" | sed "s|https://|https://postmark:${POSTMARK_TOKEN}@|")"${WEBHOOK_PATH}"
else
  WEBHOOK_URL="${TUNNEL_URL}${WEBHOOK_PATH}"
fi

echo ""
echo "=========================================="
echo "  ngrok tunnel active"
echo "=========================================="
echo ""
echo "  Postmark webhook URL:"
echo "  $WEBHOOK_URL"
echo ""
echo "  Configure in Postmark:"
echo "  Settings -> Inbound -> Webhook URL -> paste the above"
echo ""
echo "  Press Ctrl+C to stop the tunnel"
echo "=========================================="
echo ""

# Keep running and show ngrok output
wait "$NGROK_PID"
