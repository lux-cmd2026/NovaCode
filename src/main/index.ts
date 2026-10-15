import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, ConflictProposal, ProviderAuth, ProviderConfig, Settings } from '../shared/types'
import { t, localizeError } from '../shared/i18n'
import { CODEX_BASE_URL, codexStatus, configureCodex, defaultCodexAuthPath, fetchCodexModels, readAuthFile, startBrowserLogin, type BrowserLogin } from './codex-auth'
import type { LlmMessage } from './gateway/gateway'
import { McpManager, MCP_PRESETS, parseMcpJson } from './mcp'
import { loadSkills, loadProjectInstructions, skillIndexPrompt } from './skills'
import { runAgent } from './agent'
import * as G from './git'

export const CODEX_FALLBACK_MODELS = ['gpt-5.5', 'gpt-6-sol']
const BASE_PROVIDERS: ProviderConfig[] = [
  { id: 'chatgpt', name: 'ChatGPT (Codex)', kind: 'codex', baseUrl: CODEX_BASE_URL, apiKey: '', models: CODEX_FALLBACK_MODELS },
  { id: 'anthropic', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', models: ['claude-sonnet-4-5', 'claude-opus-4-1'] },
  { id: 'xai', name: 'Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', apiKey: '', models: ['grok-4', 'grok-code-fast-1'] },
  { id: 'openai', name: 'OpenAI API', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', models: ['gpt-4.1', 'gpt-4o', 'o4-mini'] },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', models: ['qwen2.5-coder'] }
]

const systemLang = (): 'zh' | 'en' => (app.getLocale?.() ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'

const DEFAULTS: Settings = {
  providers: BASE_PROVIDERS,
  activeProviderId: 'chatgpt',
  activeModel: CODEX_FALLBACK_MODELS[0],
  mcpServers: MCP_PRESETS,
  extraSkillDirs: [],
  autoApprove: false,
  workspace: null,
  recentWorkspaces: [],
  language: 'en',
  codexAuthPath: null,
  onboarded: false
}

let settings: Settings = DEFAULTS
let win: BrowserWindow | null = null
const settingsFile = () => join(app.getPath('userData'), 'settings.json')

const authPath = () => settings.codexAuthPath ?? ownCodexPath()
const ownCodexPath = () => join(app.getPath('userData'), 'codex-auth.json')

async function loadSettings() {
  let saved: Partial<Settings> | null = null
  try { saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) } catch { /* first run */ }
  settings = { ...DEFAULTS, language: systemLang(), ...(saved ?? {}) }
  // upgrades: keep user providers, add newly shipped ones (ChatGPT, Grok …)
  const have = new Set(settings.providers.map((p) => p.id))
  settings.providers = [...BASE_PROVIDERS.filter((p) => !have.has(p.id)), ...settings.providers]
  // a settings.json written before the login page existed already has a working setup
  if (saved && saved.onboarded === undefined) settings.onboarded = settings.providers.some((p) => p.apiKey && p.id !== 'custom')
  const haveM = new Set(settings.mcpServers.map((s) => s.id))
  settings.mcpServers = [...settings.mcpServers, ...MCP_PRESETS.filter((p) => !haveM.has(p.id))]
  configureCodex({ path: settings.codexAuthPath ?? ownCodexPath() })
}
const saveSettings = async () => {
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(settingsFile(), 0o600).catch(() => {}) // settings hold API keys
}

const mcp = new McpManager(() => settings.workspace)
const runs = new Map<string, AbortController>()
const approvals = new Map<string, (ok: boolean) => void>()
/** Localize an error raised in the main process (codes: `E:key:arg`, `CODEX_*`). */
export function loc(message: string): string {
  const m = message.match(/^E:([\w.]+)(?::(.*))?$/)
  if (m) return t(L(), m[1], { name: m[2] ?? '', path: m[2] ?? '' })
  return localizeError(L(), message, { path: authPath() })
}
const send = (e: AgentEvent) => win?.webContents.send('agent:event', e.type === 'error' ? { ...e, message: loc(e.message) } : e)

const L = () => settings.language
async function active() {
  const p = settings.providers.find((x) => x.id === settings.activeProviderId) ?? settings.providers[0]
  if (p.kind === 'codex') {
    if (!(await codexStatus()).loggedIn) throw new Error('CODEX_NOT_LOGGED_IN')
  } else if (!p.apiKey) throw new Error('E:err.needLogin:' + p.name)
  return { provider: p, model: settings.activeModel }
}
const ws = () => {
  if (!settings.workspace) throw new Error('E:err.needWorkspace')
  return settings.workspace
}

async function buildSystem(mode: 'chat' | 'code') {
  const skills = await loadSkills(settings.workspace, settings.extraSkillDirs)
  const inst = await loadProjectInstructions(settings.workspace)
  const base =
    mode === 'code'
      ? 'You are NovaCode, an autonomous coding agent working inside the user\'s workspace. Use tools to inspect and change files, run commands and git. Prefer small verified steps; explain briefly what you did. Reply in the user\'s language.'
      : 'You are NovaChat, a helpful AI assistant. Be concise and accurate. Reply in the user\'s language.'
  return { skills, system: [base, settings.workspace ? `Workspace: ${settings.workspace}` : '', skillIndexPrompt(skills), inst && `## Project instructions\n${inst}`].filter(Boolean).join('\n\n') }
}

function createWindow() {
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f0b1a', title: 'NovaCode', icon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}


/** Check a key against the provider's model-list endpoint (cheap, no tokens spent). */
async function verifyKey(p: ProviderConfig, key: string): Promise<string[]> {
  const base = p.baseUrl.replace(/\/+$/, '')
  const url = p.kind === 'anthropic' ? base + '/v1/models?limit=100' : base + '/models'
  const headers: Record<string, string> = p.kind === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` }
  let res: Response
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }) }
  catch (e: any) { throw new Error(t(L(), 'err.network', { name: p.name, msg: String(e?.cause?.code ?? e?.message ?? e) })) }
  if (res.status === 401 || res.status === 403) throw new Error(t(L(), 'err.keyInvalid', { name: p.name, code: res.status }))
  if (!res.ok) {
    // some gateways don't expose /models; a non-auth failure is not proof the key is bad
    return []
  }
  const j: any = await res.json().catch(() => ({}))
  const list: any[] = j.data ?? j.models ?? []
  const ids = list.map((m) => String(m.id ?? m.name ?? '')).filter(Boolean)
  return p.id === 'xai' ? ids.filter((i) => i.startsWith('grok')) : ids
}

function preferredModel(id: string, models: string[]): string {
  const pick = (re: RegExp) => models.find((m) => re.test(m))
  if (id === 'anthropic') return pick(/sonnet/) ?? models[0]
  if (id === 'xai') return pick(/^grok-4(?!.*(fast|mini))/) ?? pick(/grok-code/) ?? models[0]
  return models[0]
}

const handle = (ch: string, fn: (...a: any[]) => any) =>
  ipcMain.handle(ch, async (_e, ...a) => { try { return { ok: true, data: await fn(...a) } } catch (e: any) { return { ok: false, error: loc(String(e?.message ?? e)) } } })

function registerIpc() {
  handle('settings:get', () => settings)
  handle('settings:set', async (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    await saveSettings()
    if (patch.mcpServers || patch.workspace !== undefined) void mcp.sync(settings.mcpServers)
    return settings
  })
  handle('workspace:open', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return settings
    const p = r.filePaths[0]
    settings.workspace = p
    settings.recentWorkspaces = [p, ...settings.recentWorkspaces.filter((x) => x !== p)].slice(0, 8)
    await saveSettings()
    void mcp.sync(settings.mcpServers)
    return settings
  })
  handle('skills:list', () => loadSkills(settings.workspace, settings.extraSkillDirs))
  handle('skills:addDir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: t(L(), 'dlg.pickSkills') })
    if (!r.canceled && r.filePaths[0]) { settings.extraSkillDirs = [...new Set([...settings.extraSkillDirs, r.filePaths[0]])]; await saveSettings() }
    return settings
  })
  handle('mcp:status', () => mcp.statuses(settings.mcpServers))
  handle('mcp:sync', async () => { await mcp.sync(settings.mcpServers); return mcp.statuses(settings.mcpServers) })
  handle('mcp:importJson', async (text: string) => {
    const incoming = parseMcpJson(text)
    const map = new Map(settings.mcpServers.map((s) => [s.id, s]))
    for (const s of incoming) map.set(s.id, { ...map.get(s.id), ...s })
    settings.mcpServers = [...map.values()]
    await saveSettings()
    return settings
  })


  // ---- accounts / login ----
  let browserLogin: BrowserLogin | null = null

  const providerAuth = async (): Promise<ProviderAuth[]> => {
    const out: ProviderAuth[] = []
    for (const p of settings.providers) {
      if (p.kind === 'codex') {
        const st = await codexStatus()
        out.push({ id: p.id, connected: st.loggedIn, source: settings.codexAuthPath ? 'cli' : 'own',
          detail: st.account ? [st.account.email, st.account.plan].filter(Boolean).join(' · ') : undefined })
      } else out.push({ id: p.id, connected: !!p.apiKey && p.id !== 'custom', detail: p.apiKey && p.id !== 'custom' ? '••••' + p.apiKey.slice(-4) : undefined })
    }
    return out
  }
  const afterCodexLogin = async () => {
    const p = settings.providers.find((x) => x.kind === 'codex')!
    try { const m = await fetchCodexModels(p.baseUrl); if (m.length) p.models = m } catch { /* keep fallback list */ }
    settings.activeProviderId = p.id
    if (!p.models.includes(settings.activeModel)) settings.activeModel = p.models[0]
    settings.onboarded = true
    await saveSettings()
  }

  handle('auth:list', providerAuth)
  handle('auth:codexStart', async () => {
    browserLogin?.cancel()
    configureCodex({ path: ownCodexPath() })
    settings.codexAuthPath = null
    browserLogin = await startBrowserLogin({ storePath: ownCodexPath(), openUrl: (u) => void shell.openExternal(u) })
    const cur = browserLogin
    cur.done.then(async () => { await afterCodexLogin(); win?.webContents.send('auth:changed') })
      .catch((e) => { if (e?.message !== 'CODEX_LOGIN_CANCELLED') win?.webContents.send('auth:error', loc(String(e?.message ?? e))) })
    return { url: cur.url }
  })
  handle('auth:codexCancel', () => { browserLogin?.cancel(); browserLogin = null })
  handle('auth:codexImport', async () => {
    const path = defaultCodexAuthPath()
    try { await readAuthFile(path) } catch { throw new Error('E:err.noCodexFile:' + path) }
    settings.codexAuthPath = path
    configureCodex({ path })
    await afterCodexLogin()
    return providerAuth()
  })
  handle('auth:codexLogout', async () => {
    browserLogin?.cancel(); browserLogin = null
    // only delete the file NovaCode owns – never the Codex CLI's own login
    if (!settings.codexAuthPath) await fs.rm(ownCodexPath(), { force: true })
    settings.codexAuthPath = null
    configureCodex({ path: ownCodexPath() })
    await saveSettings()
    return providerAuth()
  })
  handle('auth:setKey', async (id: string, key: string) => {
    const p = settings.providers.find((x) => x.id === id)
    if (!p || p.kind === 'codex') throw new Error('bad provider')
    key = key.trim()
    if (!key) throw new Error('E:err.keyEmpty')
    const models = await verifyKey(p, key)
    p.apiKey = key
    if (models.length) p.models = [...new Set([...models.slice(0, 40), ...p.models.filter((m) => !models.includes(m)).slice(0, 0)])]
    if (!p.models.length) p.models = BASE_PROVIDERS.find((b) => b.id === id)?.models ?? []
    settings.activeProviderId = id
    settings.activeModel = preferredModel(id, p.models)
    settings.onboarded = true
    await saveSettings()
    return { settings, count: p.models.length }
  })
  handle('auth:removeKey', async (id: string) => {
    const p = settings.providers.find((x) => x.id === id)
    if (p) p.apiKey = ''
    if (settings.activeProviderId === id) {
      const next = settings.providers.find((x) => x.id !== id && (x.kind === 'codex' || x.apiKey))
      if (next) { settings.activeProviderId = next.id; settings.activeModel = next.models[0] }
    }
    await saveSettings()
    return settings
  })
  handle('auth:use', async (id: string) => {
    const p = settings.providers.find((x) => x.id === id)
    if (!p) return settings
    settings.activeProviderId = id
    if (!p.models.includes(settings.activeModel)) settings.activeModel = p.models[0]
    await saveSettings()
    return settings
  })
  handle('app:copy', (text: string) => clipboard.writeText(text))
  handle('app:openExternal', (url: string) => { if (/^https:\/\//.test(url)) void shell.openExternal(url) })

  // ---- chat / agent ----
  handle('agent:start', async (runId: string, mode: 'chat' | 'code', history: LlmMessage[]) => {
    const { provider, model } = await active()
    const { skills, system } = await buildSystem(mode)
    if (mode === 'code') await mcp.sync(settings.mcpServers)
    const ac = new AbortController()
    runs.set(runId, ac)
    void runAgent(runId, history, {
      workspace: mode === 'code' ? settings.workspace : null,
      provider, model, system, skills, mcp, signal: ac.signal,
      autoApprove: settings.autoApprove, emit: send,
      askApproval: (rid, id) => new Promise<boolean>((r) => approvals.set(rid + ':' + id, r))
    }).finally(() => runs.delete(runId))
  })
  handle('agent:stop', (runId: string) => { runs.get(runId)?.abort(); for (const [k, r] of approvals) if (k.startsWith(runId + ':')) { r(false); approvals.delete(k) } })
  handle('agent:approve', (runId: string, id: string, ok: boolean) => { approvals.get(runId + ':' + id)?.(ok); approvals.delete(runId + ':' + id) })

  // ---- git ----
  handle('git:status', () => (settings.workspace ? G.status(settings.workspace) : { isRepo: false, branch: '', ahead: 0, behind: 0, files: [], conflicts: [] }))
  handle('git:diff', async (file: string, staged: boolean) => (await G.git(ws(), ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file])).out)
  handle('git:stage', async (files: string[], stage: boolean) => (await G.git(ws(), stage ? ['add', '--', ...files] : ['restore', '--staged', '--', ...files])).err)
  handle('git:commit', async (msg: string) => { const r = await G.git(ws(), ['commit', '-m', msg]); if (r.code) throw new Error(r.err || r.out); return r.out })
  handle('git:commitMessage', async () => { const a = await active(); return G.generateCommitMessage(ws(), a.provider, a.model) })
  handle('git:review', async () => { const a = await active(); return G.reviewBranch(ws(), a.provider, a.model) })
  handle('git:plan', async (req: string) => { const a = await active(); return G.planNaturalLanguageGit(ws(), req, a.provider, a.model) })
  handle('git:run', (cmds: string[]) => G.runGitCommands(ws(), cmds))
  handle('git:conflictPropose', async (file: string) => { const a = await active(); return G.proposeConflictResolutions(ws(), file, a.provider, a.model) })
  handle('git:conflictApply', async (file: string, props: ConflictProposal[]) => { await G.applyProposals(ws(), file, props); await G.git(ws(), ['add', '--', file]) })
}

app.whenReady().then(async () => {
  await loadSettings()
  registerIpc()
  createWindow()
  void mcp.sync(settings.mcpServers)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('before-quit', () => { void mcp.stopAll() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
