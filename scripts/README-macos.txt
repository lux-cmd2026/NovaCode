NovaCode - macOS
================
This folder holds the UNBUILT macOS package: the source is in ../source and the build config (electron-builder.yml, build/icon.icns) is already set up.
本文件夹是“未构建”的 macOS 包:源码在 ../source,打包配置(electron-builder.yml、build/icon.icns)已就绪。

Build / 构建 (must be on a Mac / 必须在 Mac 上):
  1. Install Node.js 20+ (https://nodejs.org) / 安装 Node.js 20+
  2. In Terminal / 终端执行:  bash build-macos.sh
  3. Installers appear in source/release/ / 安装包在 source/release/ :
     NovaCode-0.1.0-mac-x64.dmg (Intel), NovaCode-0.1.0-mac-arm64.dmg (Apple Silicon)

Unsigned: first launch, right-click > Open, or: xattr -cr /Applications/NovaCode.app
未签名:首次右键 > 打开,或执行上面的 xattr 命令。

Alternative / 另一种方式: push source to GitHub and run the "Build installers" workflow.
