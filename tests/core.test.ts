import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSSE, toOpenAIMessages, toAnthropicMessages, type LlmMessage } from '../src/main/gateway/gateway'
import { parseConflicts, applyResolutions, assessRisk, isSafeGitCommand, parseStatus, splitArgs, stripFence } from '../src/main/git'
import { parseFrontMatter, loadSkills } from '../src/main/skills'
import { parseMcpJson, toolPrefix, MCP_PRESETS } from '../src/main/mcp'
import { safePath } from '../src/main/agent'

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close() } })

test('SSE parser handles events split across chunks', async () => {
  const out: any[] = []
  for await (const ev of parseSSE(streamOf(['event: a\ndata: {"x"', ':1}\n\ndata: [DONE]\n\n']))) out.push(ev)
  assert.deepEqual(out, [{ event: 'a', data: '{"x":1}' }, { event: 'message', data: '[DONE]' }])
})

const convo: LlmMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'ok', toolCalls: [{ id: 't1', name: 'read_file', args: '{"path":"a"}' }, { id: 't2', name: 'list_dir', args: '{}' }] },
  { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'A' },
  { role: 'tool', toolCallId: 't2', name: 'list_dir', content: 'B' }
]
test('OpenAI message mapping', () => {
  const m = toOpenAIMessages('sys', convo)
  assert.equal(m[0].role, 'system')
  assert.equal(m[2].tool_calls[0].function.name, 'read_file')
  assert.equal(m[3].tool_call_id, 't1')
})
test('Anthropic mapping merges consecutive tool results into ONE user turn', () => {
  const m = toAnthropicMessages(convo)
  assert.equal(m.length, 3)
  assert.equal(m[1].content[1].type, 'tool_use')
  assert.equal(m[2].role, 'user')
  assert.equal(m[2].content.length, 2)
})

const CONFLICT = `a\n<<<<<<< HEAD\nours1\n=======\ntheirs1\n>>>>>>> feature\nmid\n<<<<<<< HEAD\nours2\n||||||| base\nbase2\n=======\ntheirs2\n>>>>>>> feature\nend\n`
test('conflict parsing finds both blocks incl. diff3 base', () => {
  const b = parseConflicts(CONFLICT)
  assert.equal(b.length, 2)
  assert.equal(b[0].ours, 'ours1\n'); assert.equal(b[0].theirs, 'theirs1\n'); assert.equal(b[0].theirsLabel, 'feature')
  assert.equal(b[1].base, 'base2\n')
})
test('applying resolutions leaves no markers and keeps surrounding text', () => {
  const b = parseConflicts(CONFLICT)
  const out = applyResolutions(CONFLICT, b, new Map([[0, 'both1'], [1, 'both2\n']]))
  assert.equal(out, 'a\nboth1\nmid\nboth2\nend\n')
})
test('partial resolution keeps unresolved block verbatim', () => {
  const b = parseConflicts(CONFLICT)
  const out = applyResolutions(CONFLICT, b, new Map([[0, 'X']]))
  assert.ok(out.includes('<<<<<<< HEAD\nours2'))
  assert.ok(!out.includes('ours1'))
})
test('stripFence', () => { assert.equal(stripFence('```js\nlet a=1\n```'), 'let a=1'); assert.equal(stripFence('plain'), 'plain') })

test('git risk assessment', () => {
  assert.equal(assessRisk(['git status']), 'low')
  assert.equal(assessRisk(['git reset --soft HEAD~1']), 'medium')
  assert.equal(assessRisk(['git checkout -b feature/x']), 'medium')
  assert.equal(assessRisk(['git reset --hard HEAD~1']), 'high')
  assert.equal(assessRisk(['git push --force origin main']), 'high')
  assert.equal(assessRisk(['git clean -fd']), 'high')
  assert.equal(assessRisk(['git branch -D old']), 'high')
})
test('only plain git commands are runnable', () => {
  assert.ok(isSafeGitCommand('git log --oneline'))
  for (const bad of ['git log; rm -rf /', 'git log | cat', 'ls', 'git log && x', 'git log $(whoami)', 'git log `id`', 'git log > f'])
    assert.equal(isSafeGitCommand(bad), false, bad)
})
test('splitArgs respects quotes', () => assert.deepEqual(splitArgs('git commit -m "a b" \'c d\''), ['git', 'commit', '-m', 'a b', 'c d']))
test('parse porcelain status', () => {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\n M src/a.ts\nA  b.ts\nUU c.ts\n?? d.ts\nR  old -> new.ts\n')
  assert.equal(s.branch, 'main'); assert.equal(s.ahead, 2); assert.equal(s.behind, 1)
  assert.deepEqual(s.conflicts, ['c.ts'])
  assert.equal(s.files.length, 5)
  assert.equal(s.files[4].path, 'new.ts')
})

test('front-matter incl. folded description', () => {
  const { meta, body } = parseFrontMatter('---\nname: demo\ndescription: >\n  line one\n  line two\n---\nBODY')
  assert.equal(meta.name, 'demo'); assert.equal(meta.description, 'line one line two'); assert.equal(body, 'BODY')
})
test('skills are discovered from other agents\' folders and project overrides user', async () => {
  const home = await mkdtemp(join(tmpdir(), 'h-')); const proj = await mkdtemp(join(tmpdir(), 'p-'))
  process.env.HOME = home; process.env.USERPROFILE = home
  await mkdir(join(home, '.claude/skills/a'), { recursive: true })
  await writeFile(join(home, '.claude/skills/a/SKILL.md'), '---\nname: a\ndescription: from claude\n---\nx')
  await mkdir(join(home, '.codex/skills/b'), { recursive: true })
  await writeFile(join(home, '.codex/skills/b/SKILL.md'), '---\nname: b\ndescription: from codex\n---\nx')
  await mkdir(join(proj, '.agents/skills/a'), { recursive: true })
  await writeFile(join(proj, '.agents/skills/a/SKILL.md'), '---\nname: a\ndescription: project wins\n---\nx')
  const s = await loadSkills(proj)
  assert.deepEqual(s.map((x) => x.name), ['a', 'b'])
  assert.equal(s[0].description, 'project wins')
  assert.equal(s[1].source, 'Codex')
})

test('MCP json import (stdio + http) and presets', () => {
  const l = parseMcpJson('{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"A":"b"}},"fs":{"command":"npx","args":["-y","pkg"]}}}')
  assert.equal(l[0].transport, 'http'); assert.equal(l[1].transport, 'stdio'); assert.deepEqual(l[1].args, ['-y', 'pkg'])
  assert.equal(toolPrefix('my.srv'), 'mcp__my_srv__')
  const ids = MCP_PRESETS.map((p) => p.id)
  assert.ok(ids.includes('github') && ids.includes('gmail'))
  assert.ok(MCP_PRESETS.every((p) => !p.enabled))
})

test('safePath blocks workspace escape', () => {
  assert.ok(safePath('/w/p', 'a/b.ts').endsWith('b.ts'))
  assert.throws(() => safePath('/w/p', '../x'))
  assert.throws(() => safePath('/w/p', '/etc/passwd'))
})
