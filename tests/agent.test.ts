import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { runAgent } from '../src/main/agent'
import { McpManager } from '../src/main/mcp'
import { streamChat } from '../src/main/gateway/gateway'
import type { AgentEvent, ProviderConfig } from '../src/shared/types'

const sse = (res: http.ServerResponse, chunks: string[]) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); chunks.forEach((c) => res.write(c)); res.end() }

function fakeServer(handler: (url: string, body: any, res: http.ServerResponse) => void) {
  return new Promise<{ url: string; close: () => void }>((ok) => {
    const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => handler(req.url!, JSON.parse(b || '{}'), res)) })
    s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }))
  })
}
const oai = (o: any) => `data: ${JSON.stringify({ choices: [{ delta: o }] })}\n\n`

test('OpenAI agent loop: streams text, runs write_file after approval, reads skill, finishes', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ws-'))
  let turn = 0
  const srv = await fakeServer((_u, body, res) => {
    turn++
    if (turn === 1) sse(res, [
      oai({ content: 'Creating file. ' }),
      oai({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"hi.txt",' } }] }),
      oai({ tool_calls: [{ index: 0, function: { arguments: '"content":"hello"}' } }] }), 'data: [DONE]\n\n'])
    else {
      const last = body.messages[body.messages.length - 1]
      assert.equal(last.role, 'tool'); assert.match(last.content, /Wrote hi.txt/)
      sse(res, [oai({ content: 'Done.' }), 'data: [DONE]\n\n'])
    }
  })
  const events: AgentEvent[] = []
  const provider: ProviderConfig = { id: 'x', name: 'x', kind: 'openai', baseUrl: srv.url, apiKey: 'k', models: ['m'] }
  await runAgent('r1', [{ role: 'user', content: 'make file' }], {
    workspace: ws, provider, model: 'm', system: 's', skills: [], mcp: new McpManager(() => ws), autoApprove: false,
    emit: (e) => events.push(e), askApproval: async () => true, signal: new AbortController().signal
  })
  srv.close()
  assert.equal(await readFile(join(ws, 'hi.txt'), 'utf8'), 'hello')
  assert.ok(events.some((e) => e.type === 'approval'), 'approval requested for write')
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'done'))
  assert.equal(events.filter((e) => e.type === 'delta').map((e: any) => e.text).join(''), 'Creating file. Done.')
  assert.equal(events.at(-1)?.type, 'done')
})

test('denied approval does NOT touch the filesystem', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ws-')); let turn = 0
  const srv = await fakeServer((_u, body, res) => {
    turn++
    if (turn === 1) sse(res, [oai({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"no.txt","content":"x"}' } }] }), 'data: [DONE]\n\n'])
    else { assert.match(body.messages.at(-1).content, /denied/); sse(res, [oai({ content: 'ok' }), 'data: [DONE]\n\n']) }
  })
  const events: AgentEvent[] = []
  await runAgent('r2', [{ role: 'user', content: 'x' }], {
    workspace: ws, provider: { id: 'x', name: 'x', kind: 'openai', baseUrl: srv.url, apiKey: 'k', models: [] }, model: 'm', system: '', skills: [],
    mcp: new McpManager(() => ws), autoApprove: false, emit: (e) => events.push(e), askApproval: async () => false, signal: new AbortController().signal
  })
  srv.close()
  await assert.rejects(readFile(join(ws, 'no.txt')))
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'denied'))
})

test('path traversal from the model is rejected as a tool error', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ws-')); let turn = 0
  const srv = await fakeServer((_u, body, res) => {
    turn++
    if (turn === 1) sse(res, [oai({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"../../etc/passwd"}' } }] }), 'data: [DONE]\n\n'])
    else { assert.match(body.messages.at(-1).content, /escapes workspace/); sse(res, [oai({ content: 'blocked' }), 'data: [DONE]\n\n']) }
  })
  const events: AgentEvent[] = []
  await runAgent('r3', [{ role: 'user', content: 'x' }], {
    workspace: ws, provider: { id: 'x', name: 'x', kind: 'openai', baseUrl: srv.url, apiKey: 'k', models: [] }, model: 'm', system: '', skills: [],
    mcp: new McpManager(() => ws), autoApprove: false, emit: (e) => events.push(e), askApproval: async () => true, signal: new AbortController().signal
  })
  srv.close()
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'error'))
})

test('Anthropic streaming: text + tool_use with partial JSON', async () => {
  const srv = await fakeServer((u, body, res) => {
    assert.equal(u, '/v1/messages'); assert.equal(body.stream, true)
    const ev = (t: string, d: any) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`
    sse(res, [
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi ' } }),
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'git' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"git status"}' } }),
      ev('message_stop', {})])
  })
  let streamed = ''
  const r = await streamChat({ provider: { id: 'a', name: 'a', kind: 'anthropic', baseUrl: srv.url, apiKey: 'k', models: [] }, model: 'c',
    messages: [{ role: 'user', content: 'x' }], onDelta: (t) => (streamed += t) })
  srv.close()
  assert.equal(r.text, 'Hi '); assert.equal(streamed, 'Hi ')
  assert.deepEqual(r.toolCalls, [{ id: 'tu1', name: 'git', args: '{"command":"git status"}' }])
})

test('HTTP errors surface a readable message', async () => {
  const srv = await fakeServer((_u, _b, res) => { res.writeHead(401); res.end('{"error":"bad key"}') })
  await assert.rejects(streamChat({ provider: { id: 'x', name: 'x', kind: 'openai', baseUrl: srv.url, apiKey: 'k', models: [] }, model: 'm', messages: [{ role: 'user', content: 'x' }] }), /HTTP 401.*bad key/)
  srv.close()
})
