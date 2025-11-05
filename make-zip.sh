#!/usr/bin/env bash
# make-zip.sh — create a zip of the current project (POSIX)
# Usage: chmod +x make-zip.sh && ./make-zip.sh
set -euo pipefail

OUT="personal-copilot-local.zip"
# Exclude node_modules, .git and the zip itself
EXCLUDES=(
  "node_modules/*"
  ".git/*"
  "$OUT"
)

# Build exclude args for zip
EXCLUDE_ARGS=()
for e in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=( -x "$e" )
done

echo "Creating ${OUT} (excluding node_modules and .git)..."
# Use zip if available
if command -v zip >/dev/null 2>&1; then
  # -r recurse, -q quiet
  zip -r -q "$OUT" . "${EXCLUDE_ARGS[@]}"
  echo "Created $OUT"
else
  echo "zip command not found. You can install 'zip' (apt/yum/brew) or use the Node.js script (zip.js)."
  exit 1
fi