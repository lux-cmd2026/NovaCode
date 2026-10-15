import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpStatus } from '../shared/types'
import type { ToolDef } from './gateway/gateway'

/** Built-in presets. Users only need to fill in credentials and flip the switch. */
export const MCP_PRESETS: McpServerConfig[] = [
  {
    id: 'github',
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer <GITHUB_PERSONAL_ACCESS_TOKEN>' },
    enabled: false,
    preset: 'github',
    note: '官方 GitHub MCP。把 Authorization 里的占位符换成你的 PAT(需 repo 权限)。'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: {},
    enabled: false,
    preset: 'gmail',
    note: '首次需在终端运行 `npx @gongrzhe/server-gmail-autoauth-mcp auth`,并把 Google Cloud 的 gcp-oauth.keys.json 放到 ~/.gmail-mcp/。'
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspace}'],
    enabled: false,
    preset: 'filesystem',
    note: '${workspace} 会替换为当前工作区路径。'
  },
  {
    id: 'fetch',
    name: 'Fetch (Web)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    enabled: false,
    preset: 'fetch'
  },
  {
    id: 'playwright',
    name: 'Playwright (Browser)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    enabled: false,
    preset: 'playwright'
  }
]

export const toolPrefix = (id: string) => `mcp__${id.replace(/[^a-zA-Z0-9_-]/g, '_')}__`

export function expandVars(s: string, ctx: { workspace: string | null }): string {
  return s.replace(/\$\{workspace\}/g, ctx.workspace ?? process.cwd())
}

/** Accept the de-facto `mcpServers` JSON shape used by Claude Desktop / Cursor / Codex style configs. */
export function parseMcpJson(text: string): McpServerConfig[] {
  const raw = JSON.parse(text)
  const map = raw.mcpServers ?? raw.servers ?? raw
  const out: McpServerConfig[] = []
  for (const [id, v] of Object.entries<any>(map)) {
    if (!v || typeof v !== 'object') continue
    if (v.url) out.push({ id, name: id, transport: 'http', url: v.url, headers: v.headers, enabled: true })
    else if (v.command) out.push({ id, name: id, transport: 'stdio', command: v.command, args: v.args ?? [], env: v.env, enabled: true })
  }
  return out
}

interface Live {
  client: Client
  status: McpStatus
  tools: { name: string; description?: string; inputSchema: any }[]
}

export class McpManager {
  private live = new Map<string, Live>()
  private errors = new Map<string, string>()
  constructor(private getWorkspace: () => string | null) {}

  async sync(configs: McpServerConfig[]): Promise<void> {
    const want = new Map(configs.filter((c) => c.enabled).map((c) => [c.id, c]))
    for (const id of [...this.live.keys()]) if (!want.has(id)) await this.stop(id)
    await Promise.all(
      [...want.values()].filter((c) => !this.live.has(c.id)).map((c) => this.start(c).catch((e) => this.errors.set(c.id, String(e?.message ?? e))))
    )
  }

  async start(cfg: McpServerConfig): Promise<void> {
    this.errors.delete(cfg.id)
    const ctx = { workspace: this.getWorkspace() }
    const client = new Client({ name: 'novacode', version: '0.1.0' })
    if (cfg.transport === 'http') {
      const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expandVars(v, ctx)]))
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers } }))
    } else {
      const env = { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) }
      const isWin = process.platform === 'win32'
      const cmd = isWin && cfg.command === 'npx' ? 'npx.cmd' : cfg.command!
      await client.connect(
        new StdioClientTransport({ command: cmd, args: (cfg.args ?? []).map((a) => expandVars(a, ctx)), env, stderr: 'ignore' })
      )
    }
    const { tools } = await client.listTools()
    this.live.set(cfg.id, {
      client,
      tools: tools as any,
      status: { id: cfg.id, state: 'ready', tools: tools.map((t) => ({ name: t.name, description: t.description })) }
    })
  }

  async stop(id: string) {
    const l = this.live.get(id)
    this.live.delete(id)
    try { await l?.client.close() } catch { /* ignore */ }
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)))
  }

  statuses(configs: McpServerConfig[]): McpStatus[] {
    return configs.map((c) => {
      const l = this.live.get(c.id)
      if (l) return l.status
      const err = this.errors.get(c.id)
      return err ? { id: c.id, state: 'error', tools: [], error: err } : { id: c.id, state: 'off', tools: [] }
    })
  }

  toolDefs(): ToolDef[] {
    const out: ToolDef[] = []
    for (const [id, l] of this.live)
      for (const t of l.tools)
        out.push({
          name: toolPrefix(id) + t.name,
          description: `[MCP:${id}] ${t.description ?? ''}`.slice(0, 1000),
          parameters: t.inputSchema ?? { type: 'object', properties: {} }
        })
    return out
  }

  owns(toolName: string): boolean {
    return toolName.startsWith('mcp__')
  }

  async call(toolName: string, argsJson: string): Promise<string> {
    for (const [id, l] of this.live) {
      const p = toolPrefix(id)
      if (!toolName.startsWith(p)) continue
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(argsJson || '{}') } catch { /* empty */ }
      const res: any = await l.client.callTool({ name: toolName.slice(p.length), arguments: args })
      const text = (res.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
      return res.isError ? `ERROR: ${text}` : text
    }
    throw new Error(`No MCP server for tool ${toolName}`)
  }
}
