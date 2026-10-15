import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * ChatGPT / Codex sign-in.
 *
 * Mirrors the official Codex CLI flow (OAuth authorization-code + PKCE against auth.openai.com,
 * credentials stored in the same `auth.json` layout), so a login made with `codex login`
 * can be imported, and a login made here is readable by Codex too.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ISSUER = 'https://auth.openai.com'
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_ORIGINATOR = 'codex_cli_rs'
export const CODEX_CLIENT_VERSION = '0.157.0'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const EXPIRY_SKEW_MS = 5 * 60 * 1000

export interface CodexTokens {
  id_token: string
  access_token: string
  refresh_token: string
  account_id: string
  path: string
}
export interface CodexAccount { email?: string; plan?: string; accountId: string }

let cfg = { path: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), issuer: CODEX_ISSUER }
/** Point the module at an auth.json (NovaCode's own store, or the Codex CLI's file). */
export function configureCodex(o: { path?: string; issuer?: string }) {
  if (o.path) cfg.path = o.path
  if (o.issuer) cfg.issuer = o.issuer
}
export const defaultCodexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')

// ---------- helpers ----------
const b64url = (b: Buffer) => b.toString('base64url')

export function jwtClaims(jwt: string): Record<string, any> {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) } catch { return {} }
}
const authClaims = (jwt: string) => (jwtClaims(jwt)['https://api.openai.com/auth'] ?? {}) as Record<string, any>

export function accountOf(t: Pick<CodexTokens, 'id_token' | 'access_token' | 'account_id'>): CodexAccount {
  const idc = jwtClaims(t.id_token)
  const a = authClaims(t.id_token)
  return {
    email: idc.email, plan: a.chatgpt_plan_type ?? authClaims(t.access_token).chatgpt_plan_type,
    accountId: t.account_id || a.chatgpt_account_id || authClaims(t.access_token).chatgpt_account_id || ''
  }
}

export function tokenExpiresSoon(accessToken: string, now = Date.now()): boolean {
  const exp = jwtClaims(accessToken).exp
  if (typeof exp !== 'number') return false // opaque token: rely on 401 → refresh
  return exp * 1000 - now < EXPIRY_SKEW_MS
}

async function atomicWrite(path: string, text: string) {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.' + randomBytes(4).toString('hex') + '.tmp'
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, path)
}

export async function readAuthFile(path = cfg.path): Promise<CodexTokens> {
  let raw: any
  try { raw = JSON.parse(await fs.readFile(path, 'utf8')) } catch { throw new Error('CODEX_NOT_LOGGED_IN') }
  const t = raw?.tokens
  if (!t?.access_token || !t?.refresh_token) throw new Error('CODEX_NOT_LOGGED_IN')
  const acc = accountOf({ id_token: t.id_token ?? '', access_token: t.access_token, account_id: t.account_id ?? '' })
  if (!acc.accountId) throw new Error('CODEX_NO_ACCOUNT')
  return { id_token: t.id_token ?? '', access_token: t.access_token, refresh_token: t.refresh_token, account_id: acc.accountId, path }
}

async function writeTokens(path: string, t: Omit<CodexTokens, 'path'>) {
  let existing: any = {}
  try { existing = JSON.parse(await fs.readFile(path, 'utf8')) } catch { /* new file */ }
  const out = {
    ...existing,
    auth_mode: existing.auth_mode ?? 'chatgpt',
    OPENAI_API_KEY: existing.OPENAI_API_KEY ?? null,
    tokens: { ...(existing.tokens ?? {}), id_token: t.id_token, access_token: t.access_token, refresh_token: t.refresh_token, account_id: t.account_id },
    last_refresh: new Date().toISOString()
  }
  await atomicWrite(path, JSON.stringify(out, null, 2))
}

// ---------- refresh ----------
const flights = new Map<string, Promise<CodexTokens>>()

export function refreshTokens(observed: CodexTokens): Promise<CodexTokens> {
  const cur = flights.get(observed.path)
  if (cur) return cur
  const p = doRefresh(observed).finally(() => flights.delete(observed.path))
  flights.set(observed.path, p)
  return p
}

async function doRefresh(observed: CodexTokens): Promise<CodexTokens> {
  // Another process (e.g. the Codex CLI) may already have rotated the token – prefer its result.
  const latest = await readAuthFile(observed.path)
  if (latest.access_token !== observed.access_token && !tokenExpiresSoon(latest.access_token)) return latest
  const res = await fetch(cfg.issuer.replace(/\/+$/, '') + '/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: latest.refresh_token }),
    redirect: 'manual', signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new Error('CODEX_REFRESH_REJECTED')
    throw new Error(`CODEX_REFRESH_HTTP_${res.status}`)
  }
  const j: any = await res.json()
  if (!j.access_token) throw new Error('CODEX_REFRESH_REJECTED')
  const next = {
    id_token: j.id_token ?? latest.id_token, access_token: j.access_token,
    refresh_token: j.refresh_token ?? latest.refresh_token, account_id: latest.account_id
  }
  const acc = accountOf(next)
  if (acc.accountId && acc.accountId !== latest.account_id) throw new Error('CODEX_ACCOUNT_CHANGED')
  await writeTokens(latest.path, next)
  return { ...next, path: latest.path }
}

/** Fresh tokens for one request (refreshes when the access token is about to expire). */
export async function tokensForRequest(): Promise<CodexTokens> {
  const t = await readAuthFile()
  return tokenExpiresSoon(t.access_token) ? refreshTokens(t) : t
}

export function codexHeaders(t: CodexTokens): Record<string, string> {
  return {
    authorization: `Bearer ${t.access_token}`,
    'chatgpt-account-id': t.account_id,
    originator: CODEX_ORIGINATOR,
    'user-agent': `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (NovaCode)`
  }
}

export async function codexStatus(): Promise<{ loggedIn: boolean; account?: CodexAccount }> {
  try { return { loggedIn: true, account: accountOf(await readAuthFile()) } } catch { return { loggedIn: false } }
}

/** Visible model slugs for this account (best effort – callers fall back to a static list). */
export async function fetchCodexModels(baseUrl = CODEX_BASE_URL): Promise<string[]> {
  const t = await tokensForRequest()
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models?client_version=${CODEX_CLIENT_VERSION}`, {
    headers: codexHeaders(t), signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j: any = await res.json()
  const list: any[] = Array.isArray(j) ? j : j.models ?? []
  return list.filter((m) => m?.slug && (m.visibility === undefined || m.visibility === 'list' || m.visibility === 'visible')).map((m) => String(m.slug))
}

// ---------- browser sign-in (OAuth + PKCE) ----------
export function makePkce() {
  const verifier = b64url(randomBytes(64))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function buildAuthorizeUrl(o: { issuer?: string; redirectUri: string; challenge: string; state: string }) {
  const u = new URL((o.issuer ?? cfg.issuer).replace(/\/+$/, '') + '/oauth/authorize')
  const q: Record<string, string> = {
    response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: o.redirectUri, scope: SCOPE,
    code_challenge: o.challenge, code_challenge_method: 'S256',
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state: o.state, originator: CODEX_ORIGINATOR
  }
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return u.toString()
}

export interface BrowserLogin { url: string; port: number; done: Promise<CodexAccount>; cancel: () => void }

const page = (title: string, msg: string, ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f0b1a;color:#ece8f5;font-family:system-ui,sans-serif"><div style="text-align:center"><div style="font-size:42px;color:${ok ? '#34d399' : '#f87171'}">${ok ? '✓' : '✕'}</div><h2>${title}</h2><p style="color:#8d84a6">${msg}</p></div>`

/** Start the loopback server + return the URL to open in the user's browser. */
export async function startBrowserLogin(o: { storePath: string; openUrl: (u: string) => void; timeoutMs?: number; ports?: number[] }): Promise<BrowserLogin> {
  const { verifier, challenge } = makePkce()
  const state = b64url(randomBytes(32))
  let server!: Server
  let port = 0
  let lastErr: any
  for (const p of o.ports ?? [1455, 1457]) {
    try {
      server = createServer()
      await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(p, '127.0.0.1', () => res()) })
      port = (server.address() as any).port
      break
    } catch (e) { lastErr = e; server.close() }
  }
  if (!port) throw new Error('CODEX_PORT_BUSY:' + (lastErr?.code ?? ''))
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const url = buildAuthorizeUrl({ redirectUri, challenge, state })

  let settle!: { ok: (a: CodexAccount) => void; fail: (e: Error) => void }
  const done = new Promise<CodexAccount>((ok, fail) => { settle = { ok, fail } })
  const timer = setTimeout(() => finish(new Error('CODEX_LOGIN_TIMEOUT')), o.timeoutMs ?? 5 * 60_000)
  let closed = false
  const finish = (err?: Error, acc?: CodexAccount) => {
    if (closed) return
    closed = true; clearTimeout(timer)
    server.close(); server.closeAllConnections?.()
    err ? settle.fail(err) : settle.ok(acc!)
  }

  server.on('request', async (req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const send = (code: number, html: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }); res.end(html) }
    if (u.pathname === '/cancel') { send(200, 'bye'); return finish(new Error('CODEX_LOGIN_CANCELLED')) }
    if (u.pathname !== '/auth/callback') return send(404, 'Not found')
    if (u.searchParams.get('state') !== state) { send(400, page('Invalid state', 'Please retry the sign-in from NovaCode.', false)); return }
    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    if (err || !code) { send(400, page('Sign-in failed', u.searchParams.get('error_description') ?? err ?? 'No code', false)); return finish(new Error('CODEX_LOGIN_DENIED:' + (err ?? 'no_code'))) }
    try {
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CODEX_CLIENT_ID, code_verifier: verifier })
      const r = await fetch(cfg.issuer.replace(/\/+$/, '') + '/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000)
      })
      if (!r.ok) throw new Error('CODEX_EXCHANGE_HTTP_' + r.status)
      const j: any = await r.json()
      const acc = accountOf({ id_token: j.id_token ?? '', access_token: j.access_token ?? '', account_id: '' })
      if (!j.access_token || !j.refresh_token || !acc.accountId) throw new Error('CODEX_NO_ACCOUNT')
      await writeTokens(o.storePath, { id_token: j.id_token ?? '', access_token: j.access_token, refresh_token: j.refresh_token, account_id: acc.accountId })
      send(200, page('Signed in to NovaCode', 'You can close this tab and return to the app.', true))
      finish(undefined, acc)
    } catch (e: any) {
      send(500, page('Sign-in failed', String(e?.message ?? e), false))
      finish(e)
    }
  })

  // Surface a startup failure of openUrl without leaking the port.
  try { o.openUrl(url) } catch { /* the UI also shows the URL */ }
  return { url, port, done, cancel: () => finish(new Error('CODEX_LOGIN_CANCELLED')) }
}
