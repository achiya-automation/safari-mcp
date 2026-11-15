#!/bin/bash
# Builds the downloadable Safari MCP.app: archived with no bridge token inside (users pair
# it with `npx safari-mcp pair`), exported with a Developer ID, notarized, stapled, zipped,
# and attached to a GitHub release as Safari-MCP.app.zip. The README links to
# releases/latest/download/Safari-MCP.app.zip; release.yml carries the zip forward to
# releases cut without a new build.
#
# Needs, once per Mac:
#   1. A "Developer ID Application" certificate for team PQ7BWRHSYV in the login keychain
#      (Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application).
#   2. notarytool credentials saved under a keychain profile, with an app-specific password:
#        xcrun notarytool store-credentials safari-mcp-notary --apple-id <Apple ID> --team-id PQ7BWRHSYV
#      or with an App Store Connect API key: --key <AuthKey.p8> --key-id <id> --issuer <uuid>
#
# Usage: scripts/release-app.sh [tag]        tag defaults to v<package.json version>
#   NOTARY_PROFILE=name   keychain profile from step 2 (default: safari-mcp-notary)
#   SKIP_UPLOAD=1         build, notarize and verify build/Safari-MCP.app.zip, but upload nothing
set -euo pipefail

TEAM_ID=PQ7BWRHSYV
REPO=achiya-automation/safari-mcp
ASSET=Safari-MCP.app.zip
NOTARY_PROFILE="${NOTARY_PROFILE:-safari-mcp-notary}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-v$(node -p "require('$ROOT/package.json').version")}"
PROJECT="$ROOT/xcode/Safari MCP/Safari MCP.xcodeproj"
OUT="$ROOT/build"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/safari-mcp-release.XXXXXX")"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# Xcode registers each app it builds with LaunchServices and pluginkit. On a Mac that already runs
# Safari MCP, a second registered copy of the extension can make Safari switch to it (this one has
# no bridge token) or turn the extension off, so every copy made here is unregistered once it exists.
forget_copies() {
  local app
  while IFS= read -r -d '' app; do
    pluginkit -r "$app/Contents/PlugIns/Safari MCP Extension.appex" 2>/dev/null || true
    "$LSREGISTER" -u "$app" 2>/dev/null || true
  done < <(find "$WORK" -name "Safari MCP.app" -type d -prune -print0 2>/dev/null)
}
trap 'forget_copies; rm -rf "$WORK"' EXIT

die() { echo "release-app: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

step "Checking what this needs before the slow part"
security find-identity -v -p codesigning | grep -q "\"Developer ID Application: .*($TEAM_ID)\"" ||
  die "no \"Developer ID Application\" certificate for team $TEAM_ID in the keychain (see step 1 at the top of this script)."
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 ||
  die "notarytool cannot use keychain profile \"$NOTARY_PROFILE\" (see step 2 at the top of this script)."
if [ -z "${SKIP_UPLOAD:-}" ]; then
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || die "GitHub release $TAG does not exist yet."
fi
[ -z "$(git -C "$ROOT" status --porcelain -- extension xcode scripts)" ] ||
  die "extension/, xcode/ or scripts/ has uncommitted changes; release from a clean checkout."

step "Archiving (no bridge token)"
xcodebuild archive -quiet \
  -project "$PROJECT" -scheme "Safari MCP (macOS)" -configuration Release \
  -archivePath "$WORK/Safari MCP.xcarchive" -derivedDataPath "$WORK/DerivedData" \
  SAFARI_MCP_EMBED_BRIDGE_TOKEN=NO \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Developer ID Application" \
  PROVISIONING_PROFILE_SPECIFIER=
forget_copies

step "Exporting with Developer ID"
cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -quiet \
  -archivePath "$WORK/Safari MCP.xcarchive" \
  -exportPath "$WORK/export" \
  -exportOptionsPlist "$WORK/ExportOptions.plist"
forget_copies
APP="$WORK/export/Safari MCP.app"
[ -d "$APP" ] || die "the export produced no Safari MCP.app"

step "Verifying the signed app"
# Fail closed: a release that carried the builder's token would hand it to everyone.
FOUND="$(find "$APP" -name bridge-auth-token)" || die "could not search the whole app for a bridge-auth-token."
[ -z "$FOUND" ] || die "the app contains a bridge-auth-token; refusing to publish it."
codesign --verify --deep --strict --verbose=2 "$APP"
SIGNATURE="$(codesign -dvv "$APP" 2>&1)"
grep -q "^Authority=Developer ID Application: .*($TEAM_ID)" <<<"$SIGNATURE" || die "the app is not signed with this team's Developer ID."
grep -q "flags=.*runtime" <<<"$SIGNATURE" || die "the hardened runtime is off; notarization would refuse the app."
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
MANIFEST_VERSION="$(node -p "require('$ROOT/extension/manifest.json').version")"
[ "$VERSION" = "$MANIFEST_VERSION" ] || die "app version $VERSION differs from the extension manifest ($MANIFEST_VERSION)."

step "Notarizing Safari MCP $VERSION (usually a few minutes)"
ditto -c -k --keepParent "$APP" "$WORK/notarize.zip"
xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait \
  --output-format json > "$WORK/notary.json" || true
STATUS="$(node -p "JSON.parse(require('fs').readFileSync('$WORK/notary.json','utf8')).status" 2>/dev/null || echo unknown)"
if [ "$STATUS" != "Accepted" ]; then
  SUBMISSION="$(node -p "JSON.parse(require('fs').readFileSync('$WORK/notary.json','utf8')).id" 2>/dev/null || true)"
  if [ -n "$SUBMISSION" ]; then
    xcrun notarytool log "$SUBMISSION" --keychain-profile "$NOTARY_PROFILE" || true
  else
    cat "$WORK/notary.json"
  fi
  die "notarization ended with status \"$STATUS\"."
fi

step "Stapling and checking Gatekeeper"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP" 2>&1 | tee "$WORK/spctl.txt"
grep -q "source=Notarized Developer ID" "$WORK/spctl.txt" || die "Gatekeeper does not see a notarized Developer ID app."

mkdir -p "$OUT"
rm -f "$OUT/$ASSET" "$OUT/$ASSET.sha256"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$ASSET"
(cd "$OUT" && shasum -a 256 "$ASSET" > "$ASSET.sha256")
step "Built $OUT/$ASSET (Safari MCP $VERSION)"
cat "$OUT/$ASSET.sha256"

if [ -n "${SKIP_UPLOAD:-}" ]; then
  echo "SKIP_UPLOAD is set: nothing uploaded."
  exit 0
fi
step "Attaching to GitHub release $TAG"
gh release upload "$TAG" "$OUT/$ASSET" "$OUT/$ASSET.sha256" --repo "$REPO" --clobber
echo "Done: https://github.com/$REPO/releases/tag/$TAG"
