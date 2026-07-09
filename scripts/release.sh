#!/bin/bash
# Build, sign, notarize, and publish a Hive release with updater metadata.
#
# One-time setup:
#   1. Developer ID cert: Xcode → Settings → Accounts → Manage Certificates →
#      + → "Developer ID Application" (must exist in your login keychain;
#      verify with `security find-identity -v -p codesigning`).
#   2. cp scripts/signing.env.example ~/.hive/signing.env && chmod 600 it,
#      then fill in the Apple credentials.
#   3. Updater key already lives at ~/.tauri/hive-updater.key (chmod 600).
#
# Usage: ./scripts/release.sh            # uses version from tauri.conf.json
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v$VERSION"
echo "==> Releasing Hive $TAG"

# Signing + notarization (optional but recommended — unsigned builds make
# users fight Gatekeeper). Missing file = ad-hoc build, same as dev.
if [ -f "$HOME/.hive/signing.env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.hive/signing.env"
  export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  echo "==> Signing as: $APPLE_SIGNING_IDENTITY (notarizing via $APPLE_ID)"
else
  echo "==> WARNING: ~/.hive/signing.env not found — building UNSIGNED"
fi

# Updater artifact signature
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/hive-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

npm run tauri build

BUNDLE=src-tauri/target/release/bundle
DMG="$BUNDLE/dmg/Hive_${VERSION}_aarch64.dmg"
APPGZ="$BUNDLE/macos/Hive.app.tar.gz"
SIG="$BUNDLE/macos/Hive.app.tar.gz.sig"
test -f "$DMG" && test -f "$APPGZ" && test -f "$SIG"

# Updater manifest — the endpoint the app polls
python3 - "$VERSION" "$SIG" <<'EOF'
import json, sys, datetime
version, sigpath = sys.argv[1], sys.argv[2]
manifest = {
    "version": version,
    "notes": f"Hive {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "platforms": {
        "darwin-aarch64": {
            "signature": open(sigpath).read(),
            "url": f"https://github.com/thetaylorpratt/hive/releases/download/v{version}/Hive.app.tar.gz",
        }
    },
}
json.dump(manifest, open("latest.json", "w"), indent=2)
EOF

gh release create "$TAG" "$DMG" "$APPGZ" latest.json \
  --repo thetaylorpratt/hive \
  --title "Hive $VERSION" \
  --notes "See README for install + setup. Auto-updates from here on."
rm latest.json

# Building the DMG mounts a volume that LaunchServices auto-registers; the
# volume unmounts but the registration lingers at a dead /Volumes path. Left
# unchecked these pile up (all claiming com.taylorpratt.hive), and macOS can
# resolve the default-browser handler to a dead copy → link opens in Safari.
# Detach any leftover build volume and re-assert the installed app as the
# sole registration.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for v in /Volumes/dmg.*; do
  [ -d "$v/Hive.app" ] && hdiutil detach "$v" -quiet 2>/dev/null || true
done
"$LSREGISTER" -u "$BUNDLE/macos/Hive.app" 2>/dev/null || true
[ -d /Applications/Hive.app ] && "$LSREGISTER" -f /Applications/Hive.app || true

echo "==> Done: https://github.com/thetaylorpratt/hive/releases/tag/$TAG"
