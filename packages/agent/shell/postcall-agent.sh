#!/usr/bin/env bash
# postcall-agent.sh — minimal shell agent using only curl + GET
#
# Usage:
#   ./postcall-agent.sh <gateway_url>
#
# Demonstrates that an AI agent needs only curl to communicate via postcall.

set -euo pipefail

GATEWAY="${1:-http://localhost:3000}"

echo "=== postcall shell agent ==="
echo "Gateway: $GATEWAY"
echo ""

# Health check
echo "--- Health Check ---"
curl -s "${GATEWAY}/v1/health" | python3 -m json.tool 2>/dev/null || curl -s "${GATEWAY}/v1/health"
echo ""

# Note: Full agent registration requires a secp256k1 key pair.
# This shell script demonstrates the GET-only API pattern.
# For production use, see the TypeScript PostcallClient.

echo "--- List Agents ---"
curl -s "${GATEWAY}/v1/agents" | python3 -m json.tool 2>/dev/null || curl -s "${GATEWAY}/v1/agents"
echo ""

echo "=== Done ==="
echo "All postcall operations use GET requests only."
echo "For full agent functionality (key generation, signing), use the TypeScript SDK:"
echo "  npm install @postcall/agent"
