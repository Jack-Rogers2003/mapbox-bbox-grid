#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm build
pnpm exec tsx scripts/dump.ts
exec pnpm dlx http-server . -p 8000
