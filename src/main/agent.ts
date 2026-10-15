import { promises as fs } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { exec } from 'node:child_process'
import type { AgentEvent, ProviderConfig, SkillInfo } from '../shared/types'
import { streamChat, type LlmMessage, type ToolDef } from './gateway/gateway'
import type { McpManager } from './mcp'
import { readSkill } from './skills'
import { git, splitArgs, isSafeGitCommand, assessRisk } from './git'

export const BUILTIN_TOOLS: ToolDef[] = [
  { name: 'read_file', description: 'Read a UTF-8 text file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_dir', description: 'List entries in a workspace directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'search_text', description: 'Search text (regex) across workspace files; returns file:line matches.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string' } }, required: ['pattern'] } },
  { name: 'run_command', description: 'Run a shell command in the workspace and return output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'git', description: 'Run a plain git command (e.g. "git status"). No pipes or shell operators.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'use_skill', description: 'Load the full instructions of a named skill.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
]

const READONLY = new Set(['read_file', 'list_dir', 'search_text', 'use_skill'])

/** Resolve a user/model-supplied path and make sure it stays inside the workspace. */
export function safePath(workspace: string, p: string): string {
  const abs = resolve(workspace, p || '.')
  const rel = relative(workspace, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`)
  return abs
}

export function needsApproval(name: string, args: any, mcp: McpManager): boolean {
  if (READONLY.has(name)) return false
  if (name === 'git') {
    const c = String(args?.command ?? '')
    return !(isSafeGitCommand(c) && assessRisk([c]) === 'low' && /^git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|blame)\b/.test(c))
  }
  if (mcp.owns(name)) return true
  return true // write_file, run_command
}

async function walk(dir: string, out: string[], limit = 4000) {
  let ents
  try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (out.length >= limit) return
    if (['node_modules', '.git', 'out', 'dist', 'release'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out, limit)
    else out.push(p)
  }
}

export interface AgentDeps {
  workspace: string | null
  provider: ProviderConfig
  model: string
  system: string
  skills: SkillInfo[]
  mcp: McpManager
  autoApprove: boolean
  emit: (e: AgentEvent) => void
  askApproval: (runId: string, id: string, name: string, args: string) => Promise<boolean>
  signal: AbortSignal
}

export async function execTool(name: string, argsJson: string, d: AgentDeps): Promise<string> {
  let a: any = {}
  try { a = JSON.parse(argsJson || '{}') } catch { return 'ERROR: invalid JSON arguments' }
  const ws = d.workspace
  if (d.mcp.owns(name)) return d.mcp.call(name, argsJson)
  if (name === 'use_skill') {
    const s = d.skills.find((x) => x.name === a.name)
    return s ? readSkill(s.file) : `Unknown skill "${a.name}". Available: ${d.skills.map((x) => x.name).join(', ')}`
  }
  if (!ws) return 'ERROR: no workspace open'
  switch (name) {
    case 'read_file': return (await fs.readFile(safePath(ws, a.path), 'utf8')).slice(0, 200_000)
    case 'write_file': {
      const p = safePath(ws, a.path)
      await fs.mkdir(join(p, '..'), { recursive: true })
      await fs.writeFile(p, String(a.content ?? ''), 'utf8')
      return `Wrote ${a.path} (${String(a.content ?? '').length} chars)`
    }
    case 'list_dir': {
      const ents = await fs.readdir(safePath(ws, a.path || '.'), { withFileTypes: true })
      return ents.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n')
    }
    case 'search_text': {
      const re = new RegExp(String(a.pattern), 'i')
      const files: string[] = []
      await walk(safePath(ws, a.dir || '.'), files)
      const hits: string[] = []
      for (const f of files) {
        if (hits.length >= 200) break
        let t: string
        try { t = await fs.readFile(f, 'utf8') } catch { continue }
        if (t.includes('\u0000')) continue
        t.split('\n').forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(`${relative(ws, f)}:${i + 1}: ${l.slice(0, 200)}`) })
      }
      return hits.join('\n') || 'No matches'
    }
    case 'run_command':
      return new Promise((res) => {
        exec(String(a.command), { cwd: ws, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, so, se) =>
          res(((so as string) + (se as string)).slice(-20000) + (e ? `\n(exit ${(e as any).code ?? 1})` : ''))
        )
      })
    case 'git': {
      const c = String(a.command ?? '')
      if (!isSafeGitCommand(c)) return 'ERROR: only a single plain git command is allowed'
      const r = await git(ws, splitArgs(c).slice(1))
      return (r.out + r.err).slice(-20000) + (r.code ? `\n(exit ${r.code})` : '')
    }
  }
  return `ERROR: unknown tool ${name}`
}

export async function runAgent(runId: string, history: LlmMessage[], d: AgentDeps, maxSteps = 20): Promise<void> {
  const tools = [...BUILTIN_TOOLS.filter((t) => d.workspace || t.name === 'use_skill'), ...d.mcp.toolDefs()]
  const msgs: LlmMessage[] = [...history]
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (d.signal.aborted) break
      const r = await streamChat({
        provider: d.provider, model: d.model, system: d.system, messages: msgs, tools, signal: d.signal,
        onDelta: (t) => d.emit({ runId, type: 'delta', text: t })
      })
      msgs.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls })
      if (!r.toolCalls.length) break
      for (const tc of r.toolCalls) {
        let args: any = {}
        try { args = JSON.parse(tc.args || '{}') } catch { /* handled in execTool */ }
        let result: string
        if (needsApproval(tc.name, args, d.mcp) && !d.autoApprove) {
          d.emit({ runId, type: 'approval', id: tc.id, name: tc.name, args: tc.args })
          const ok = await d.askApproval(runId, tc.id, tc.name, tc.args)
          if (!ok) {
            d.emit({ runId, type: 'tool', id: tc.id, name: tc.name, args: tc.args, status: 'denied' })
            msgs.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: 'User denied this action.' })
            continue
          }
        }
        d.emit({ runId, type: 'tool', id: tc.id, name: tc.name, args: tc.args, status: 'running' })
        try {
          result = await execTool(tc.name, tc.args, d)
          d.emit({ runId, type: 'tool', id: tc.id, name: tc.name, args: tc.args, status: 'done', result: result.slice(0, 4000) })
        } catch (e: any) {
          result = `ERROR: ${e?.message ?? e}`
          d.emit({ runId, type: 'tool', id: tc.id, name: tc.name, args: tc.args, status: 'error', result })
        }
        msgs.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: result })
      }
    }
    d.emit({ runId, type: 'done' })
  } catch (e: any) {
    if (d.signal.aborted) d.emit({ runId, type: 'done' })
    else d.emit({ runId, type: 'error', message: String(e?.message ?? e) })
  }
}
