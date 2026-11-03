#!/usr/bin/env bash
#
# Build the Sorvex desktop app as a Windows x64 NSIS installer, cross-compiled from Linux.
#
# The installer ships everything the app needs, so the target machine needs no Node or Sorvex install:
#   node/node.exe       pinned Node runtime that runs the server
#   server/index.mjs    the desktop server, bundled with the workspace sources (scripts/bundle-server.mjs)
#   extension/          the GUI bridge extension the agent loads
#   sorvex/sorvex.exe   the Sorvex binary (scripts/build-binaries.sh), run in RPC mode by the server
#   dist/               the built UI
#
# Requirements: bun, cargo-xwin (`cargo install --locked cargo-xwin`), clang-cl, lld-link, llvm-rc, makensis,
# the x86_64-pc-windows-msvc Rust target, and a repository install (`npm install --ignore-scripts`).
#
# Usage: apps/desktop/scripts/build-windows.sh [--skip-sorvex]
#   --skip-sorvex  Reuse the Sorvex binary staged by a previous run instead of rebuilding all packages.
#
# Output: apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Sorvex_<version>_x64-setup.exe

set -euo pipefail

NODE_VERSION="v26.13.0"
NODE_SHA256="14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5"
TARGET="x86_64-pc-windows-msvc"

SKIP_SORVEX=false
while [[ $# -gt 0 ]]; do
	case $1 in
		--skip-sorvex)
			SKIP_SORVEX=true
			shift
			;;
		*)
			echo "Unknown option: $1"
			exit 1
			;;
	esac
done

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
BUILD_DIR="$APP_DIR/build"
STAGE_DIR="$BUILD_DIR/windows"
CACHE_DIR="$BUILD_DIR/cache"

missing=()
for tool in bun cargo-xwin clang-cl lld-link llvm-rc makensis; do
	command -v "$tool" >/dev/null || missing+=("$tool")
done
rustup target list --installed | grep -qx "$TARGET" || missing+=("rust target $TARGET (rustup target add $TARGET)")
if [[ ${#missing[@]} -gt 0 ]]; then
	echo "Missing build requirements:"
	printf '  %s\n' "${missing[@]}"
	exit 1
fi

mkdir -p "$STAGE_DIR" "$CACHE_DIR"

echo "==> Sorvex binary"
if [[ "$SKIP_SORVEX" == "true" ]]; then
	[[ -f "$STAGE_DIR/sorvex/sorvex.exe" ]] || { echo "No staged Sorvex binary; run without --skip-sorvex first."; exit 1; }
	echo "Reusing $STAGE_DIR/sorvex"
else
	bash "$REPO_ROOT/scripts/build-binaries.sh" --skip-install --offline-model-data --platform windows-x64 --out "$BUILD_DIR/sorvex-binaries"
	rm -rf "$STAGE_DIR/sorvex"
	cp -R "$BUILD_DIR/sorvex-binaries/windows-x64" "$STAGE_DIR/sorvex"
fi

echo "==> Node $NODE_VERSION"
node_exe="$CACHE_DIR/node-$NODE_VERSION-win-x64.exe"
if [[ ! -f "$node_exe" ]] || ! echo "$NODE_SHA256  $node_exe" | sha256sum --check --status; then
	curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/win-x64/node.exe" -o "$node_exe.part"
	echo "$NODE_SHA256  $node_exe.part" | sha256sum --check --quiet
	mv "$node_exe.part" "$node_exe"
fi
rm -rf "$STAGE_DIR/node"
mkdir -p "$STAGE_DIR/node"
cp "$node_exe" "$STAGE_DIR/node/node.exe"

echo "==> Desktop server"
node "$APP_DIR/scripts/bundle-server.mjs" "$STAGE_DIR"

echo "==> Installer"
cd "$APP_DIR"
npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

echo ""
echo "==> Done"
ls -lh "$APP_DIR/src-tauri/target/$TARGET/release/bundle/nsis/"*.exe
