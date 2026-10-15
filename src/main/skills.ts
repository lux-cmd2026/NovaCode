import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillInfo } from '../shared/types'

/** Parse `---\nkey: value\n---` front-matter (flat keys only; enough for SKILL.md). */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    let val = kv[2].trim()
    if (/^[>|][+-]?$/.test(val)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim())
      val = parts.join(' ')
    }
    meta[kv[1]] = val.replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

/** Skill roots from other agent tools that NovaCode understands. */
export function skillRoots(workspace: string | null, extra: string[] = []): { source: string; dir: string }[] {
  const h = homedir()
  const roots = [
    { source: 'NovaCode', dir: join(h, '.novacode', 'skills') },
    { source: 'Claude', dir: join(h, '.claude', 'skills') },
    { source: 'Codex', dir: join(h, '.codex', 'skills') },
    { source: 'Agents', dir: join(h, '.agents', 'skills') },
    { source: 'Cursor', dir: join(h, '.cursor', 'skills') }
  ]
  if (workspace)
    roots.push(
      { source: 'Project·NovaCode', dir: join(workspace, '.novacode', 'skills') },
      { source: 'Project·Claude', dir: join(workspace, '.claude', 'skills') },
      { source: 'Project·Codex', dir: join(workspace, '.codex', 'skills') },
      { source: 'Project·Agents', dir: join(workspace, '.agents', 'skills') }
    )
  for (const d of extra) roots.push({ source: 'Custom', dir: d })
  return roots
}

export async function loadSkills(workspace: string | null, extra: string[] = []): Promise<SkillInfo[]> {
  const out = new Map<string, SkillInfo>()
  for (const { source, dir } of skillRoots(workspace, extra)) {
    let entries: string[] = []
    try { entries = await fs.readdir(dir) } catch { continue }
    for (const e of entries) {
      const file = join(dir, e, 'SKILL.md')
      try {
        const { meta } = parseFrontMatter(await fs.readFile(file, 'utf8'))
        const name = meta.name || e
        out.set(name, { name, description: meta.description ?? '', source, dir: join(dir, e), file }) // later roots (project) override
      } catch { /* not a skill dir */ }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function readSkill(file: string): Promise<string> {
  return parseFrontMatter(await fs.readFile(file, 'utf8')).body.trim()
}

/** Project instruction files used by other agent tools. All are folded into the system prompt. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', 'NOVACODE.md']

export async function loadProjectInstructions(workspace: string | null): Promise<string> {
  if (!workspace) return ''
  const parts: string[] = []
  for (const f of INSTRUCTION_FILES) {
    try {
      const t = (await fs.readFile(join(workspace, f), 'utf8')).trim()
      if (t) parts.push(`### ${f}\n${t.slice(0, 8000)}`)
    } catch { /* absent */ }
  }
  return parts.join('\n\n')
}

export function skillIndexPrompt(skills: SkillInfo[]): string {
  if (!skills.length) return ''
  return (
    '## Available skills\nCall the `use_skill` tool with a skill name to load its full instructions when the task matches.\n' +
    skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  )
}
