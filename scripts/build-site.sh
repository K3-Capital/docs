#!/usr/bin/env bash
#
# Build every documentation source and assemble the docs.k3.capital site.
#
# This is the single entry point used by CI (.github/workflows/deploy.yml) and by local
# verification, so the artifact that is checked locally is produced by the same steps
# that produce the deployed one.
#
# Environment:
#   VAULT_DIR  checkout of K3-Capital/k3-vault-docs (default: vendor/k3-vault-docs)
#   OUT_DIR    site output directory              (default: _site)
#   SKIP_BUILD set to 1 to reuse an existing vault build (local iteration only)
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-vendor/k3-vault-docs}"
OUT_DIR="${OUT_DIR:-_site}"

cd "$(dirname "$0")/.."

if [ ! -d "$VAULT_DIR" ]; then
  echo "Vault docs checkout not found: $VAULT_DIR" >&2
  exit 1
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building vault documentation from $VAULT_DIR"
  (
    cd "$VAULT_DIR"
    if [ "${SKIP_INSTALL:-0}" != "1" ]; then
      npm ci
    fi
    npm run build
  )
fi

echo "==> Assembling $OUT_DIR"
node scripts/assemble-site.mjs --vault-build "$VAULT_DIR/_book" --out "$OUT_DIR"
