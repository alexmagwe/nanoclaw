#!/usr/bin/env bash
# Launch LiteLLM proxy for NanoClaw → DeepSeek translation.
#
# Reads DEEPSEEK_API_KEY from .env file in the project root.
# Usage: ./scripts/run-litellm.sh [--install] [--port 4000]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$PROJECT_DIR/litellm_config.yaml"
PORT="${LITELLM_PORT:-4000}"

# Parse args
INSTALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Add pip user bin to PATH (litellm may be installed here)
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

# Load DEEPSEEK_API_KEY from .env
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source <(grep '^DEEPSEEK_API_KEY=' "$PROJECT_DIR/.env")
  set +a
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "ERROR: DEEPSEEK_API_KEY not found in .env"
  echo "Add it to .env: DEEPSEEK_API_KEY=sk-..."
  exit 1
fi

# Install LiteLLM if needed
if [ "$INSTALL" = true ] || ! command -v litellm &>/dev/null; then
  echo "Installing LiteLLM..."
  pip3 install litellm[proxy] 2>&1 | tail -1
fi

if ! command -v litellm &>/dev/null; then
  echo "ERROR: litellm not found after install. Check pip3 installation."
  exit 1
fi

echo "Starting LiteLLM on port $PORT..."
echo "Config: $CONFIG"
echo ""

exec litellm \
  --config "$CONFIG" \
  --port "$PORT" \
  --detailed_debug
