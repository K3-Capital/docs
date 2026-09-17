#!/usr/bin/env bash
#
# Build every documentation source and assemble the docs.k3.capital site.
#
# This is the single entry point used by CI (.github/workflows/deploy.yml) and by local
# verification, so the artifact that is checked locally is produced by the same steps
# that produce the deployed one.
#
# Environment:
#   VAULT_DIR    checkout of K3-Capital/k3-vault-docs (default: vendor/k3-vault-docs)
#   SBOLT_DIR    checkout of K3-Capital/sBOLT-docs    (default: vendor/sBOLT-docs)
#   OUT_DIR      site output directory                (default: _site)
#   SKIP_BUILD   set to 1 to reuse existing source builds (local iteration only)
#   SKIP_INSTALL set to 1 to skip npm ci in each source (local iteration only)
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-vendor/k3-vault-docs}"
SBOLT_DIR="${SBOLT_DIR:-vendor/sBOLT-docs}"
OUT_DIR="${OUT_DIR:-_site}"

cd "$(dirname "$0")/.."

for checkout in "$VAULT_DIR" "$SBOLT_DIR"; do
  if [ ! -d "$checkout" ]; then
    echo "Documentation source checkout not found: $checkout" >&2
    exit 1
  fi
done

build_docs_set() {
  local label="$1" dir="$2"
  echo "==> Building $label documentation from $dir"
  (
    cd "$dir"
    if [ "${SKIP_INSTALL:-0}" != "1" ]; then
      npm ci
    fi
    npm run build
  )
}

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  build_docs_set vault "$VAULT_DIR"
  build_docs_set sBOLD "$SBOLT_DIR"
fi

echo "==> Assembling $OUT_DIR"
node scripts/assemble-site.mjs \
  --vault-build "$VAULT_DIR/_book" \
  --sbolt-build "$SBOLT_DIR/_book" \
  --out "$OUT_DIR"
