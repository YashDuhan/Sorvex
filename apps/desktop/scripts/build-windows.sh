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
# Linux NSIS builds ship only amd64 stubs, but Tauri's installer script and plugin target x86-unicode. Its data
# directory (stubs, plugins, includes) comes from the official Windows release of the same version as makensis.
NSIS_VERSION="3.13"
NSIS_SHA256="ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8"
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

echo "==> NSIS $NSIS_VERSION data"
makensis_version="$(makensis -VERSION)"
[[ "$makensis_version" == "v$NSIS_VERSION" ]] || { echo "makensis is $makensis_version; this script expects v$NSIS_VERSION"; exit 1; }
nsis_zip="$CACHE_DIR/nsis-$NSIS_VERSION.zip"
if [[ ! -f "$nsis_zip" ]] || ! echo "$NSIS_SHA256  $nsis_zip" | sha256sum --check --status; then
	curl -fsSL "https://downloads.sourceforge.net/project/nsis/NSIS%203/$NSIS_VERSION/nsis-$NSIS_VERSION.zip" -o "$nsis_zip.part"
	echo "$NSIS_SHA256  $nsis_zip.part" | sha256sum --check --quiet
	mv "$nsis_zip.part" "$nsis_zip"
fi
rm -rf "$CACHE_DIR/nsis-$NSIS_VERSION"
unzip -q "$nsis_zip" -d "$CACHE_DIR"
# makensis loads its default (amd64) stub before reading any script, so keep those, then switch every script to x86.
system_nsisdir="$(env -u NSISDIR makensis -HDRINFO | grep -o 'NSISDIR=[^,]*' | cut -d= -f2)"
nsis_dir="$CACHE_DIR/nsis-$NSIS_VERSION"
cp "$system_nsisdir"/Stubs/*-amd64-unicode "$nsis_dir/Stubs/"
printf '\nTarget x86-unicode\n' >>"$nsis_dir/nsisconf.nsh"
# Tauri sets NSISDIR and NSISCONFDIR for makensis itself, so point them at this directory from a wrapper instead.
mkdir -p "$CACHE_DIR/bin"
printf '#!/bin/sh\nexec env NSISDIR="%s" NSISCONFDIR="%s" "%s" "$@"\n' "$nsis_dir" "$nsis_dir" "$(command -v makensis)" >"$CACHE_DIR/bin/makensis"
chmod +x "$CACHE_DIR/bin/makensis"
export PATH="$CACHE_DIR/bin:$PATH"

echo "==> Desktop server"
node "$APP_DIR/scripts/bundle-server.mjs" "$STAGE_DIR"

echo "==> Installer"
cd "$APP_DIR"
npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

echo ""
echo "==> Done"
ls -lh "$APP_DIR/src-tauri/target/$TARGET/release/bundle/nsis/"*.exe
