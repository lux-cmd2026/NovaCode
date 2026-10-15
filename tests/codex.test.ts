import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthorizeUrl, configureCodex, makePkce, readAuthFile, startBrowserLogin, tokenExpiresSoon, tokensForRequest, accountOf, refreshTokens,
  CODEX_CLIENT_ID
} from '../src/main/codex-auth'
import { streamChat, toResponsesInput } from '../src/main/gateway/gateway'
import { en, zh, t, localizeError } from '../src/shared/i18n'

const jwt = (payload: object) => 'x.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.y'
const idToken = (acc = 'acct_1') => jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: acc, chatgpt_plan_type: 'plus' } })
const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)) })
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as any).port)))

test('PKCE challenge is S256 of the verifier', () => {
  const { verifier, challenge } = makePkce()
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.ok(verifier.length >= 43)
})

test('authorize URL carries the Codex parameters', () => {
  const u = new URL(buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge: 'c', state: 's' }))
  assert.equal(u.origin + u.pathname, 'https://auth.openai.com/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.match(u.searchParams.get('scope')!, /offline_access/)
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
})

test('jwt helpers: account, plan and expiry', () => {
  const acc = accountOf({ id_token: idToken('acct_9'), access_token: jwt({}), account_id: '' })
  assert.deepEqual([acc.accountId, acc.email, acc.plan], ['acct_9', 'me@example.com', 'plus'])
  const now = 1_000_000_000_000
  assert.equal(tokenExpiresSoon(jwt({ exp: now / 1000 + 3600 }), now), false)
  assert.equal(tokenExpiresSoon(jwt({ exp: now / 1000 + 60 }), now), true)
  assert.equal(tokenExpiresSoon('opaque', now), false)
})

/** Mock of auth.openai.com + the Codex backend. */
async function mockWorld() {
  const state = { refreshCalls: 0, exchangeBody: '', responsesAuth: [] as string[], reject401Once: false, refreshStatus: 200 }
  const server = createServer(async (req, res) => {
    const b = await body(req)
    if (req.url === '/oauth/token' && req.headers['content-type']?.includes('x-www-form-urlencoded')) {
      state.exchangeBody = b
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ id_token: idToken(), access_token: jwt({ exp: 4102444800 }), refresh_token: 'rt_1' }))
    }
    if (req.url === '/oauth/token') {
      state.refreshCalls++
      if (state.refreshStatus !== 200) { res.statusCode = state.refreshStatus; return res.end('{}') }
      assert.equal(JSON.parse(b).grant_type, 'refresh_token')
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ access_token: jwt({ exp: 4102444800, n: state.refreshCalls }), refresh_token: 'rt_' + (state.refreshCalls + 1) }))
    }
    if (req.url === '/responses') {
      state.responsesAuth.push(String(req.headers.authorization))
      assert.equal(req.headers['chatgpt-account-id'], 'acct_1')
      if (state.reject401Once) { state.reject401Once = false; res.statusCode = 401; return res.end('{}') }
      const j = JSON.parse(b)
      assert.equal(j.stream, true); assert.equal(j.store, false)
      res.setHeader('content-type', 'text/event-stream')
      const ev = (o: any) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
      ev({ type: 'response.output_text.delta', delta: 'Hel' })
      ev({ type: 'response.output_text.delta', delta: 'lo' })
      ev({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' } })
      ev({ type: 'response.completed', response: {} })
      return res.end()
    }
    res.statusCode = 404; res.end()
  })
  const port = await listen(server)
  const dir = await mkdtemp(join(tmpdir(), 'nova-codex-'))
  const path = join(dir, 'auth.json')
  configureCodex({ path, issuer: `http://127.0.0.1:${port}` })
  return { state, port, path, close: () => { server.close(); server.closeAllConnections() } }
}
const seed = (path: string, access: string) => writeFile(path, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken(), access_token: access, refresh_token: 'rt_0', account_id: 'acct_1' } }))

test('browser login: callback with matching state exchanges the code and writes auth.json (0600)', async () => {
  const w = await mockWorld()
  try {
    let opened = ''
    const login = await startBrowserLogin({ storePath: w.path, openUrl: (u) => { opened = u }, ports: [0] })
    const u = new URL(opened)
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    const cb = `http://127.0.0.1:${login.port}/auth/callback`
    // wrong state is refused and does not finish the login
    const bad = await fetch(cb + '?code=abc&state=nope')
    assert.equal(bad.status, 400)
    const ok = await fetch(cb + `?code=abc&state=${u.searchParams.get('state')}`)
    assert.equal(ok.status, 200)
    const acc = await login.done
    assert.equal(acc.accountId, 'acct_1')
    const form = new URLSearchParams(w.state.exchangeBody)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'abc')
    assert.equal(form.get('code_verifier')!.length >= 43, true)
    assert.equal(form.get('redirect_uri'), cb)
    const saved = JSON.parse(await readFile(w.path, 'utf8'))
    assert.equal(saved.tokens.refresh_token, 'rt_1'); assert.equal(saved.tokens.account_id, 'acct_1'); assert.equal(saved.auth_mode, 'chatgpt')
    if (process.platform !== 'win32') assert.equal((await stat(w.path)).mode & 0o777, 0o600)
  } finally { w.close() }
})

test('browser login: denial and cancel reject cleanly', async () => {
  const w = await mockWorld()
  try {
    const a = await startBrowserLogin({ storePath: w.path, openUrl: () => {}, ports: [0] })
    const aErr = a.done.then(() => null, (e) => e as Error)
    a.cancel()
    assert.match(String((await aErr)?.message), /CODEX_LOGIN_CANCELLED/)

    let url = ''
    const b = await startBrowserLogin({ storePath: w.path, openUrl: (u) => { url = u }, ports: [0] })
    const bErr = b.done.then(() => null, (e) => e as Error)
    const state = new URL(url).searchParams.get('state')
    const r = await fetch(`http://127.0.0.1:${b.port}/auth/callback?error=access_denied&state=${state}`)
    assert.equal(r.status, 400)
    assert.match(String((await bErr)?.message), /CODEX_LOGIN_DENIED:access_denied/)
  } finally { w.close() }
})

test('port conflict is reported with a code', async () => {
  const blocker = createServer(); const p = await listen(blocker)
  const w = await mockWorld()
  try { await assert.rejects(startBrowserLogin({ storePath: w.path, openUrl: () => {}, ports: [p] }), /CODEX_PORT_BUSY/) }
  finally { blocker.close(); w.close() }
})

test('expired access token is refreshed before use and persisted', async () => {
  const w = await mockWorld()
  try {
    await seed(w.path, jwt({ exp: 1 })) // long expired
    const tk = await tokensForRequest()
    assert.equal(w.state.refreshCalls, 1)
    assert.notEqual(tk.access_token, jwt({ exp: 1 }))
    const saved = JSON.parse(await readFile(w.path, 'utf8'))
    assert.equal(saved.tokens.refresh_token, 'rt_2')
    assert.equal(saved.tokens.account_id, 'acct_1')
    assert.ok(saved.last_refresh)
  } finally { w.close() }
})

test('concurrent refreshes share one request', async () => {
  const w = await mockWorld()
  try {
    await seed(w.path, jwt({ exp: 1 }))
    const cur = await readAuthFile()
    await Promise.all([refreshTokens(cur), refreshTokens(cur), refreshTokens(cur)])
    assert.equal(w.state.refreshCalls, 1)
  } finally { w.close() }
})

test('rejected refresh token surfaces CODEX_REFRESH_REJECTED', async () => {
  const w = await mockWorld()
  try {
    await seed(w.path, jwt({ exp: 1 })); w.state.refreshStatus = 400
    await assert.rejects(tokensForRequest(), /CODEX_REFRESH_REJECTED/)
  } finally { w.close() }
})

test('missing auth.json → CODEX_NOT_LOGGED_IN', async () => {
  const w = await mockWorld()
  try { await assert.rejects(readAuthFile(join(w.path, '..', 'nope.json')), /CODEX_NOT_LOGGED_IN/) } finally { w.close() }
})

const provider = (port: number) => ({ id: 'chatgpt', name: 'ChatGPT', kind: 'codex' as const, baseUrl: `http://127.0.0.1:${port}`, apiKey: '', models: ['m'] })

test('codex channel streams text + tool calls through the Responses API', async () => {
  const w = await mockWorld()
  try {
    await seed(w.path, jwt({ exp: 4102444800 }))
    const deltas: string[] = []
    const r = await streamChat({ provider: provider(w.port), model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }], onDelta: (d) => deltas.push(d) })
    assert.equal(r.text, 'Hello'); assert.deepEqual(deltas, ['Hel', 'lo'])
    assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'read_file', args: '{"path":"a"}' }])
  } finally { w.close() }
})

test('codex channel: a 401 triggers one refresh then succeeds with the new token', async () => {
  const w = await mockWorld()
  try {
    await seed(w.path, jwt({ exp: 4102444800 }))
    w.state.reject401Once = true
    const r = await streamChat({ provider: provider(w.port), model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.text, 'Hello')
    assert.equal(w.state.refreshCalls, 1)
    assert.equal(w.state.responsesAuth.length, 2)
    assert.notEqual(w.state.responsesAuth[0], w.state.responsesAuth[1])
  } finally { w.close() }
})

test('Responses input mapping keeps tool call / output pairs', () => {
  const m = toResponsesInput([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', toolCalls: [{ id: 't1', name: 'x', args: '{}' }] },
    { role: 'tool', toolCallId: 't1', name: 'x', content: 'out' }
  ])
  assert.deepEqual(m.map((i) => i.type), ['message', 'message', 'function_call', 'function_call_output'])
  assert.equal(m[2].call_id, m[3].call_id)
})

// ---------- i18n ----------
test('en and zh dictionaries have identical keys and no empty values', () => {
  const ek = Object.keys(en).sort(), zk = Object.keys(zh).sort()
  assert.deepEqual(ek, zk)
  for (const k of ek) { assert.ok(en[k].trim(), 'en ' + k); assert.ok(zh[k].trim(), 'zh ' + k) }
})

test('placeholders match between languages', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  for (const k of Object.keys(en)) assert.equal(ph(en[k]), ph(zh[k]), k)
})

test('t() interpolates and localizeError maps codes in both languages', () => {
  assert.equal(t('zh', 'git.conflicts', { n: 3 }), '3 个冲突文件')
  assert.equal(t('en', 'git.conflicts', { n: 3 }), '3 conflicted file(s)')
  assert.match(localizeError('zh', 'CODEX_REFRESH_REJECTED'), /过期/)
  assert.match(localizeError('en', 'CODEX_REFRESH_REJECTED'), /expired/)
  assert.match(localizeError('en', 'CODEX_LOGIN_DENIED:access_denied'), /access_denied/)
  assert.match(localizeError('en', 'CODEX_EXCHANGE_HTTP_403'), /403/)
  assert.equal(localizeError('en', 'something else'), 'something else')
})
