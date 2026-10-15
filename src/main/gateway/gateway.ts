import type { ProviderConfig } from '../../shared/types'
import { codexHeaders, refreshTokens, tokensForRequest } from '../codex-auth'

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON schema
}
export interface ToolCall {
  id: string
  name: string
  args: string // raw JSON
}
export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface StreamResult {
  text: string
  toolCalls: ToolCall[]
}
export interface StreamOptions {
  provider: ProviderConfig
  model: string
  system?: string
  messages: LlmMessage[]
  tools?: ToolDef[]
  signal?: AbortSignal
  onDelta?: (t: string) => void
  maxTokens?: number
}

/** Parse an SSE byte stream into {event,data} records. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
      let event = 'message'
      const data: string[] = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) yield { event, data: data.join('\n') }
    }
  }
}

const join = (base: string, path: string) => base.replace(/\/+$/, '') + path

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${t.slice(0, 400)}`)
  }
  return res.body
}

// ---------- OpenAI-compatible (Chat Completions) ----------
export function toOpenAIMessages(system: string | undefined, msgs: LlmMessage[]) {
  const out: any[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      const o: any = { role: 'assistant', content: m.content || null }
      if (m.toolCalls?.length)
        o.tool_calls = m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } }))
      out.push(o)
    } else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
  }
  return out
}

async function streamOpenAI(o: StreamOptions): Promise<StreamResult> {
  const body: any = {
    model: o.model,
    stream: true,
    messages: toOpenAIMessages(o.system, o.messages)
  }
  if (o.maxTokens) body.max_tokens = o.maxTokens
  if (o.tools?.length)
    body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  const stream = await post(join(o.provider.baseUrl, '/chat/completions'), { authorization: `Bearer ${o.provider.apiKey}` }, body, o.signal)
  let text = ''
  const calls = new Map<number, ToolCall>()
  for await (const ev of parseSSE(stream)) {
    if (ev.data === '[DONE]') break
    let j: any
    try { j = JSON.parse(ev.data) } catch { continue }
    const d = j.choices?.[0]?.delta
    if (!d) continue
    if (d.content) { text += d.content; o.onDelta?.(d.content) }
    for (const tc of d.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(tc.index, cur)
    }
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v], i) => ({ ...v, id: v.id || `call_${i}` }))
  return { text, toolCalls }
}

// ---------- Anthropic Messages ----------
export function toAnthropicMessages(msgs: LlmMessage[]) {
  const out: any[] = []
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      const blocks: any[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(t.args || '{}') } catch { /* keep {} */ }
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    }
  }
  return out
}

async function streamAnthropic(o: StreamOptions): Promise<StreamResult> {
  const body: any = {
    model: o.model,
    stream: true,
    max_tokens: o.maxTokens ?? 8192,
    messages: toAnthropicMessages(o.messages)
  }
  if (o.system) body.system = o.system
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  const stream = await post(
    join(o.provider.baseUrl, '/v1/messages'),
    { 'x-api-key': o.provider.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    o.signal
  )
  let text = ''
  const blocks = new Map<number, ToolCall>()
  for await (const ev of parseSSE(stream)) {
    let j: any
    try { j = JSON.parse(ev.data) } catch { continue }
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use')
      blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, args: '' })
    else if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta') { text += j.delta.text; o.onDelta?.(j.delta.text) }
      else if (j.delta?.type === 'input_json_delta') {
        const b = blocks.get(j.index)
        if (b) b.args += j.delta.partial_json
      }
    } else if (j.type === 'error') throw new Error(j.error?.message ?? 'anthropic stream error')
  }
  return { text, toolCalls: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) }
}

// ---------- ChatGPT / Codex (Responses API, OAuth bearer) ----------
export function toResponsesInput(msgs: LlmMessage[]) {
  const out: any[] = []
  for (const m of msgs) {
    if (m.role === 'user') out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] })
    else if (m.role === 'assistant') {
      if (m.content) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      for (const t of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: t.args || '{}' })
    } else out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
  }
  return out
}

async function streamCodex(o: StreamOptions): Promise<StreamResult> {
  const body: any = {
    model: o.model,
    instructions: o.system || 'You are a helpful assistant.',
    input: toResponsesInput(o.messages),
    tools: (o.tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
    store: false,
    include: []
  }
  let res: Response | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokens = await tokensForRequest()
    res = await fetch(join(o.provider.baseUrl, '/responses'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...codexHeaders(tokens) },
      body: JSON.stringify(body), signal: o.signal, redirect: 'manual'
    })
    if (res.status === 401 && attempt === 0) { await res.body?.cancel().catch(() => {}); await refreshTokens(tokens); continue }
    break
  }
  if (!res) throw new Error('CODEX_NO_RESPONSE')
  if (res.status === 401) throw new Error('CODEX_UNAUTHORIZED')
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${t.slice(0, 400)}`)
  }
  let text = ''
  const toolCalls: ToolCall[] = []
  for await (const ev of parseSSE(res.body)) {
    let j: any
    try { j = JSON.parse(ev.data) } catch { continue }
    switch (j.type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string') { text += j.delta; o.onDelta?.(j.delta) }
        break
      case 'response.output_item.done':
        if (j.item?.type === 'function_call')
          toolCalls.push({ id: j.item.call_id || j.item.id || `call_${toolCalls.length}`, name: j.item.name, args: j.item.arguments || '{}' })
        break
      case 'response.failed':
        throw new Error(j.response?.error?.message ?? 'codex response failed')
      case 'error':
        throw new Error(j.message ?? j.error?.message ?? 'codex stream error')
    }
  }
  return { text, toolCalls }
}

export function streamChat(o: StreamOptions): Promise<StreamResult> {
  return o.provider.kind === 'anthropic' ? streamAnthropic(o) : o.provider.kind === 'codex' ? streamCodex(o) : streamOpenAI(o)
}

/** Non-streaming convenience used by Git helpers (commit msg, review, ...). */
export async function complete(o: Omit<StreamOptions, 'onDelta' | 'tools'>): Promise<string> {
  return (await streamChat(o)).text
}
