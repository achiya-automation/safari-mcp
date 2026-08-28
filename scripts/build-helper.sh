#!/bin/bash
# Build safari-helper as a universal binary with a low deployment target.
#
# Why both knobs matter (regression that shipped in v2.16.x): building with a bare
# `swiftc -O` stamps the *build* machine's arch and SDK into the binary. On an Apple
# Silicon Mac running macOS 26 that yields an arm64-only, minos-26.0 helper — dyld then
# refuses to load it on Intel Macs and on every macOS older than 26, and because the
# helper is spawned lazily the user just sees "helper process exited" on every tool call.
set -euo pipefail

cd "$(dirname "$0")/.."

DEPLOYMENT_TARGET="${SAFARI_HELPER_DEPLOYMENT_TARGET:-13.0}"
STABLE_ID="com.achiya-automation.safari-mcp"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for arch in arm64 x86_64; do
  echo "  building $arch (macOS $DEPLOYMENT_TARGET)…"
  swiftc -O -target "${arch}-apple-macos${DEPLOYMENT_TARGET}" \
    -o "$TMP/safari-helper-$arch" safari-helper.swift
done

lipo -create "$TMP/safari-helper-arm64" "$TMP/safari-helper-x86_64" -output safari-helper
codesign -s - -f --identifier "$STABLE_ID" --entitlements safari-helper.entitlements safari-helper

echo "built: $(lipo -archs safari-helper) @ macOS $DEPLOYMENT_TARGET"
codesign -d --verbose=2 safari-helper 2>&1 | grep -E 'Identifier|Format'
