import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import * as G from '../src/main/git'

const sh = (cwd: string, a: string[]) => G.git(cwd, a)
function llm(reply: (prompt: string) => string) {
  return new Promise<{ url: string; close: () => void }>((ok) => {
    const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const body = JSON.parse(b); const p = body.messages.at(-1).content
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply(p) } }] })}\n\ndata: [DONE]\n\n`); res.end() }) })
    s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }))
  })
}

test('real repo: conflict -> AI proposal -> apply -> staged & marker-free; commit message from staged diff', async () => {
  const d = await mkdtemp(join(tmpdir(), 'repo-'))
  await sh(d, ['init', '-b', 'main']); await sh(d, ['config', 'user.email', 't@t']); await sh(d, ['config', 'user.name', 't'])
  await writeFile(join(d, 'a.ts'), 'export const x = 1\n'); await sh(d, ['add', '.']); await sh(d, ['commit', '-m', 'init'])
  await sh(d, ['checkout', '-b', 'feature']); await writeFile(join(d, 'a.ts'), 'export const x = 2 // feature\n'); await sh(d, ['commit', '-am', 'feat'])
  await sh(d, ['checkout', 'main']); await writeFile(join(d, 'a.ts'), 'export const x = 3 // main\n'); await sh(d, ['commit', '-am', 'main change'])
  const m = await sh(d, ['merge', 'feature']); assert.notEqual(m.code, 0)

  const st = await G.status(d)
  assert.equal(st.isRepo, true); assert.deepEqual(st.conflicts, ['a.ts'])

  const srv = await llm((p) => {
    assert.match(p, /<<<OURS[\s\S]*x = 3/); assert.match(p, /<<<THEIRS[\s\S]*x = 2/)
    return 'REASON: both bump x; keep main value and note feature.\n```ts\nexport const x = 3 // main + feature\n```'
  })
  const prov = { id: 'p', name: 'p', kind: 'openai' as const, baseUrl: srv.url, apiKey: 'k', models: [] }
  const props = await G.proposeConflictResolutions(d, 'a.ts', prov, 'm')
  assert.equal(props.length, 1); assert.match(props[0].reason, /both bump x/)
  await G.applyProposals(d, 'a.ts', props); await sh(d, ['add', '--', 'a.ts'])
  const txt = await readFile(join(d, 'a.ts'), 'utf8')
  assert.equal(txt, 'export const x = 3 // main + feature\n'); assert.ok(!/<<<<<<<|>>>>>>>/.test(txt))
  assert.deepEqual((await G.status(d)).conflicts, [])
  srv.close()

  const srv2 = await llm((p) => { assert.match(p, /\+export const x = 3/); return 'feat(core): merge feature into main' })
  const msg = await G.generateCommitMessage(d, { ...prov, baseUrl: srv2.url }, 'm')
  assert.equal(msg, 'feat(core): merge feature into main'); srv2.close()
})

test('NL git: risk floor cannot be lowered by the model; unsafe commands are filtered', async () => {
  const d = await mkdtemp(join(tmpdir(), 'repo-')); await sh(d, ['init', '-b', 'main'])
  const srv = await llm(() => JSON.stringify({ explanation: 'wipe', risk: 'low', commands: ['git reset --hard HEAD~1', 'rm -rf /', 'git log; echo x'] }))
  const plan = await G.planNaturalLanguageGit(d, '撤销', { id: 'p', name: 'p', kind: 'openai', baseUrl: srv.url, apiKey: 'k', models: [] }, 'm')
  srv.close()
  assert.deepEqual(plan.commands, ['git reset --hard HEAD~1']); assert.equal(plan.risk, 'high')
})

test('NL git: "undo last commit keep changes" really executes and keeps work', async () => {
  const d = await mkdtemp(join(tmpdir(), 'repo-')); await sh(d, ['init', '-b', 'main']); await sh(d, ['config', 'user.email', 't@t']); await sh(d, ['config', 'user.name', 't'])
  await writeFile(join(d, 'f'), '1'); await sh(d, ['add', '.']); await sh(d, ['commit', '-m', 'one'])
  await writeFile(join(d, 'f'), '2'); await sh(d, ['commit', '-am', 'two'])
  const log = await G.runGitCommands(d, ['git reset --soft HEAD~1'])
  assert.match(log, /\$ git reset --soft/)
  assert.equal((await sh(d, ['log', '--oneline'])).out.trim().split('\n').length, 1)
  assert.equal(await readFile(join(d, 'f'), 'utf8'), '2')
  const bad = await G.runGitCommands(d, ['git status', 'ls -la', 'git log'])
  assert.match(bad, /rejected/); assert.ok(!bad.includes('$ git log'))
})
