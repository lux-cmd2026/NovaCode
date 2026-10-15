# NovaCode

AI coding workspace for desktop · AI 编程工作台。Top-bar switch **NovaChat / NovaCode**, purple four-point-star icon. UI in **English and 中文** (switch on the login page or in Settings → General; first launch follows your system language).

## Sign-in · 登录

The first launch shows a login page (you can skip it to use a custom endpoint such as Ollama). Later: **Settings → Account**.

| Provider | How it works |
|---|---|
| **ChatGPT (Codex)** | **Sign in with ChatGPT** opens your browser (OAuth + PKCE, loopback on `127.0.0.1:1455`, falls back to `1457`). Or **Use existing Codex login** to share `~/.codex/auth.json` (honours `CODEX_HOME`) with the Codex CLI. Tokens refresh automatically; the file is written with owner-only permissions. Requests go to `chatgpt.com/backend-api/codex` (Responses API). |
| **Claude** | Anthropic API key from console.anthropic.com. Checked against `/v1/models` before it is saved. Claude.ai subscriptions cannot be used by third-party apps, so there is no "Sign in with Claude" button. |
| **Grok** | xAI API key from console.x.ai, checked against `/v1/models`. |

- "Sign out" on ChatGPT deletes only NovaCode's own copy. If you chose "Use existing Codex login", the CLI's `auth.json` is **never** deleted — NovaCode just stops using it.
- API keys live in `settings.json` (mode 600) in the app's user-data folder; nothing is sent anywhere except the provider you chose.
- ChatGPT sign-in uses the same public client as the Codex CLI. It is not an officially supported third-party integration; OpenAI can change or restrict it. API keys remain the stable option.

## Features · 功能
- **Model gateway**: ChatGPT/Codex (Responses API), Anthropic Messages, and any OpenAI-compatible endpoint (Ollama, DeepSeek, OpenRouter…).
- **NovaCode agent**: read/write files, search, run commands, Git. Writes, commands and MCP calls ask for approval each time; paths outside the workspace are rejected.
- **MCP**: presets for GitHub, Gmail, Filesystem, Fetch, Playwright; stdio and HTTP; import Claude Desktop / Cursor / Codex style `mcpServers` JSON.
- **Skills**: reads `SKILL.md` from `~/.novacode|.claude|.codex|.agents|.cursor/skills` and the same folders in the workspace; understands `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`.
- **AI Git**: Conventional Commits messages, AI merge-conflict proposals (preview, then apply), natural-language Git with risk levels (high risk needs a second confirmation), branch review.

## Install · 安装
Download from the Actions run / Release:

| OS | File |
|---|---|
| Windows | `NovaCode-<ver>-win-x64.exe`, `NovaCode-<ver>-win-arm64.exe` |
| macOS | `NovaCode-<ver>-mac-x64.dmg`, `NovaCode-<ver>-mac-arm64.dmg` |
| Linux (x64) | `NovaCode-<ver>-linux-x86_64.AppImage` · `NovaCode-<ver>-linux-amd64.deb` |

Linux:
```bash
chmod +x NovaCode-*.AppImage && ./NovaCode-*.AppImage     # AppImage (needs FUSE; otherwise add --appimage-extract-and-run)
sudo apt install ./NovaCode-*-linux-amd64.deb             # Debian / Ubuntu
```
The zip you received already contains these two Linux files under `linux/`, built and start-tested on x64. If your system blocks the Chromium sandbox (running as root, some containers), add `--no-sandbox`.

Builds are unsigned: Windows shows SmartScreen; on macOS use right-click → Open the first time.

## Develop · 开发
```bash
npm install
npm run dev
npm test && npm run typecheck
```

## Build installers · 出安装包
GitHub Actions (`.github/workflows/build.yml`): run **Build installers**, or `git tag v0.1.0 && git push --tags` to also publish a Release. Local: `npm run dist:linux` (on Linux), `dist:win` (on Windows), `dist:mac` (on macOS).

## First-time setup · 首次使用
- **Settings → Account**: sign in / paste a key.
- **Settings → MCP**: GitHub — replace the `Authorization` placeholder with `Bearer <your PAT>`, then enable. Gmail — run `npx @gongrzhe/server-gmail-autoauth-mcp auth` once (needs a Google Cloud OAuth `gcp-oauth.keys.json`), then enable.

## Roadmap · 路线图
Inline completion (ghost text), Cmd+K inline edit, codebase RAG index.
