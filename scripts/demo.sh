#!/usr/bin/env bash
# Offline end-to-end demo: real controller + fake workers (no LLM, no credentials).
# Usage: scripts/demo.sh [--out DIR] [--keep]     (default output: ./demo-output)
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/demo.ts "$@"
