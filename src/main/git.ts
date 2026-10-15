import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ConflictProposal, GitStatus, NlGitPlan } from '../shared/types'
import { complete } from './gateway/gateway'
import type { ProviderConfig } from '../shared/types'

export function git(cwd: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (e: any, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(stdout), err: String(stderr) })
    )
    if (input !== undefined) p.stdin?.end(input)
  })
}

export function parseStatus(porcelain: string): GitStatus {
  const st: GitStatus = { isRepo: true, branch: '', ahead: 0, behind: 0, files: [], conflicts: [] }
  for (const line of porcelain.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const m = line.slice(3).match(/^(?:No commits yet on |Initial commit on )?([^\s.]+(?:\.[^\s.]+)*?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/)
      st.branch = m?.[1] ?? line.slice(3)
      const info = m?.[2] ?? ''
      st.ahead = Number(info.match(/ahead (\d+)/)?.[1] ?? 0)
      st.behind = Number(info.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const index = line[0]
    const worktree = line[1]
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1]
    path = path.replace(/^"|"$/g, '')
    st.files.push({ path, index, worktree })
    const pair = index + worktree
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair)) st.conflicts.push(path)
  }
  return st
}

export async function status(cwd: string): Promise<GitStatus> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-b'])
  if (r.code !== 0) return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [], conflicts: [] }
  return parseStatus(r.out)
}

// ---------------- merge conflicts ----------------
export interface ConflictBlock {
  index: number
  start: number // char offsets in file
  end: number
  ours: string
  theirs: string
  base?: string
  oursLabel: string
  theirsLabel: string
}

export function parseConflicts(text: string): ConflictBlock[] {
  const re = /^<{7} ?(.*)\r?\n([\s\S]*?)(?:^\|{7} ?.*\r?\n([\s\S]*?))?^={7}\r?\n([\s\S]*?)^>{7} ?(.*)\r?\n?/gm
  const out: ConflictBlock[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({
      index: out.length,
      start: m.index,
      end: m.index + m[0].length,
      oursLabel: m[1],
      ours: m[2],
      base: m[3],
      theirs: m[4],
      theirsLabel: m[5]
    })
  }
  return out
}

/** Replace blocks (by index) with resolved text. Unlisted blocks are kept untouched. */
export function applyResolutions(text: string, blocks: ConflictBlock[], resolved: Map<number, string>): string {
  let out = ''
  let pos = 0
  for (const b of blocks) {
    out += text.slice(pos, b.start)
    if (resolved.has(b.index)) {
      const r = resolved.get(b.index)!
      out += r.endsWith('\n') || r === '' ? r : r + '\n'
    } else out += text.slice(b.start, b.end)
    pos = b.end
  }
  return out + text.slice(pos)
}

export function stripFence(s: string): string {
  const m = s.trim().match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return m ? m[1] : s
}

export async function proposeConflictResolutions(
  cwd: string,
  file: string,
  provider: ProviderConfig,
  model: string
): Promise<ConflictProposal[]> {
  const text = await fs.readFile(join(cwd, file), 'utf8')
  const blocks = parseConflicts(text)
  const out: ConflictProposal[] = []
  for (const b of blocks) {
    const prompt =
      `You resolve git merge conflicts. File: ${file}\n` +
      `Ours (${b.oursLabel}):\n<<<OURS\n${b.ours}OURS>>>\n` +
      (b.base ? `Base:\n<<<BASE\n${b.base}BASE>>>\n` : '') +
      `Theirs (${b.theirsLabel}):\n<<<THEIRS\n${b.theirs}THEIRS>>>\n\n` +
      'First line: REASON: <one sentence describing both intents and why this merge is correct>.\n' +
      'Then the merged code ONLY, in one fenced block. Keep both intents where compatible. No conflict markers.'
    const reply = await complete({ provider, model, messages: [{ role: 'user', content: prompt }], maxTokens: 4096 })
    const reason = reply.match(/REASON:\s*(.*)/)?.[1]?.trim() ?? ''
    const code = stripFence(reply.replace(/^.*REASON:.*\r?\n/m, '').trim())
    out.push({ file, index: b.index, resolved: code, reason })
  }
  return out
}

export async function applyProposals(cwd: string, file: string, props: ConflictProposal[]): Promise<void> {
  const path = join(cwd, file)
  const text = await fs.readFile(path, 'utf8')
  const blocks = parseConflicts(text)
  const map = new Map(props.map((p) => [p.index, p.resolved]))
  await fs.writeFile(path, applyResolutions(text, blocks, map), 'utf8')
}

// ---------------- commit message ----------------
export async function generateCommitMessage(cwd: string, provider: ProviderConfig, model: string): Promise<string> {
  let diff = (await git(cwd, ['diff', '--cached', '--no-color'])).out
  if (!diff.trim()) diff = (await git(cwd, ['diff', '--no-color'])).out
  if (!diff.trim()) throw new Error('E:git.err.nothingToCommit')
  const stat = (await git(cwd, ['diff', '--cached', '--stat'])).out
  const log = (await git(cwd, ['log', '-5', '--pretty=%s'])).out
  const reply = await complete({
    provider,
    model,
    system: 'You write git commit messages in Conventional Commits format: type(scope): subject (<=72 chars, imperative), blank line, short body of bullet points if needed. Output the message only.',
    messages: [{ role: 'user', content: `Recent commits:\n${log}\nStat:\n${stat}\nDiff:\n${diff.slice(0, 60000)}` }],
    maxTokens: 600
  })
  return stripFence(reply).trim()
}

export async function reviewBranch(cwd: string, provider: ProviderConfig, model: string, base?: string): Promise<string> {
  let target = base
  if (!target) {
    for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
      if ((await git(cwd, ['rev-parse', '--verify', c])).code === 0) { target = c; break }
    }
  }
  let diff = target ? (await git(cwd, ['diff', '--no-color', `${target}...HEAD`])).out : ''
  const wt = (await git(cwd, ['diff', '--no-color', 'HEAD'])).out
  diff = (diff + '\n' + wt).trim()
  if (!diff) throw new Error('E:git.err.nothingToReview')
  return complete({
    provider,
    model,
    system:
      'You are a senior code reviewer. Review the diff. Output Markdown with sections: Summary, Bugs (file:line + why + fix), Security, Performance, Suggestions. Be concrete; skip praise; say "None found" for empty sections.',
    messages: [{ role: 'user', content: diff.slice(0, 120000) }],
    maxTokens: 4000
  })
}

// ---------------- natural-language git ----------------
/** Rule-based risk floor: model output can raise risk, never lower it below this. */
export function assessRisk(cmds: string[]): 'low' | 'medium' | 'high' {
  let level: 0 | 1 | 2 = 0
  for (const c of cmds) {
    const s = c.trim()
    if (/\b(reset\s+--hard|clean\s+-\w*[fd]|push\b.*(--force|-f\b|--force-with-lease)|branch\s+-D|checkout\s+--\s|restore\b.*--source|filter-branch|reflog\s+expire|gc\s+--prune)/.test(s)) level = 2
    else if (/\b(reset|rebase|merge|cherry-pick|revert|commit\s+--amend|push|stash\s+(drop|clear)|checkout|switch|restore|tag\s+-d|branch\s+-d)\b/.test(s)) level = Math.max(level, 1) as 0 | 1 | 2
  }
  return (['low', 'medium', 'high'] as const)[level]
}

export function isSafeGitCommand(c: string): boolean {
  const s = c.trim()
  if (!/^git\s/.test(s)) return false
  return !/[;&|`$<>\n]|\$\(/.test(s) // single plain git invocation only
}

export function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export async function planNaturalLanguageGit(cwd: string, request: string, provider: ProviderConfig, model: string): Promise<NlGitPlan> {
  const st = await git(cwd, ['status', '-sb'])
  const lg = await git(cwd, ['log', '--oneline', '-8'])
  const reply = await complete({
    provider,
    model,
    system:
      'Translate the request into git commands. Reply with ONLY JSON: {"explanation":string,"risk":"low|medium|high","commands":string[]}. Each command is one plain `git ...` invocation (no pipes, no &&, no shell). Prefer non-destructive variants (e.g. reset --soft, --force-with-lease).',
    messages: [{ role: 'user', content: `Repo state:\n${st.out}\nRecent:\n${lg.out}\nRequest: ${request}` }],
    maxTokens: 800
  })
  const json = reply.match(/\{[\s\S]*\}/)?.[0] ?? '{}'
  const p = JSON.parse(json)
  const commands: string[] = (p.commands ?? []).filter(isSafeGitCommand)
  const floor = assessRisk(commands)
  const order = { low: 0, medium: 1, high: 2 } as const
  const risk = order[p.risk as keyof typeof order] > order[floor] ? p.risk : floor
  return { explanation: String(p.explanation ?? ''), risk, commands }
}

export async function runGitCommands(cwd: string, cmds: string[]): Promise<string> {
  let log = ''
  for (const c of cmds) {
    if (!isSafeGitCommand(c)) { log += `$ ${c}\n(rejected: not a plain git command)\n`; break }
    const r = await git(cwd, splitArgs(c).slice(1))
    log += `$ ${c}\n${r.out}${r.err}`
    if (r.code !== 0) { log += `(exit ${r.code}, stopped)\n`; break }
  }
  return log
}
