#!/usr/bin/env bash
# NovaCode - build macOS installers (dmg: Intel x64 + Apple Silicon arm64). Must be run on a Mac.
# NovaCode - 构建 macOS 安装包(Intel x64 + Apple 芯片 arm64),必须在 Mac 上运行。
set -euo pipefail
cd "$(dirname "$0")"
if [ -f ../source/package.json ]; then cd ../source; elif [ -f ../package.json ]; then cd ..; fi
[ "$(uname)" = "Darwin" ] || { echo "This script must run on macOS / 请在 macOS 上运行"; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ required: https://nodejs.org / 需要 Node.js 20+"; exit 1; }
export CSC_IDENTITY_AUTO_DISCOVERY=false   # unsigned build / 不签名
npm ci
npm run build
npx electron-builder --mac --x64 --arm64 --publish never
echo
echo "Done. Output / 完成,产物:"; ls -1 release/*.dmg
echo "First launch on a Mac: right-click the app > Open, or run: xattr -cr /Applications/NovaCode.app"
echo "首次打开:右键应用 > 打开,或执行 xattr -cr /Applications/NovaCode.app"
