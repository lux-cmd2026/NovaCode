NovaCode - Windows
==================
This folder holds the UNBUILT Windows package: the source is in ../source and the build config (electron-builder.yml, build/icon.ico) is already set up.
本文件夹是“未构建”的 Windows 包:源码在 ../source,打包配置(electron-builder.yml、build/icon.ico)已就绪。

Build / 构建:
  1. Install Node.js 20+ (https://nodejs.org) / 安装 Node.js 20+
  2. Double-click build-windows.bat / 双击 build-windows.bat
  3. Installers appear in source\release\ / 安装包在 source\release\ :
     NovaCode-0.1.0-win-x64.exe, NovaCode-0.1.0-win-arm64.exe

Alternative / 另一种方式: push source to GitHub and run the "Build installers" workflow (.github/workflows/build.yml).
把 source 推到 GitHub,运行 “Build installers” 工作流即可。
