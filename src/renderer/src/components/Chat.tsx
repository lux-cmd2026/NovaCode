import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent, Mode } from '@shared/types'
import logo from '../assets/logo.png'
import { useT } from '../i18n'

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; status: string; result?: string }
  | { kind: 'approval'; id: string; name: string; args: string }
export interface Turn { role: 'user' | 'assistant'; text: string; blocks: Block[] }

const uid = () => Math.random().toString(36).slice(2, 10)

export function applyEvent(blocks: Block[], e: AgentEvent): Block[] {
  const b = [...blocks]
  if (e.type === 'delta') {
    const last = b[b.length - 1]
    if (last?.kind === 'text') b[b.length - 1] = { ...last, text: last.text + e.text }
    else b.push({ kind: 'text', text: e.text })
  } else if (e.type === 'approval') b.push({ kind: 'approval', id: e.id, name: e.name, args: e.args })
  else if (e.type === 'tool') {
    const i = b.findIndex((x) => (x.kind === 'tool' || x.kind === 'approval') && x.id === e.id)
    const nb: Block = { kind: 'tool', id: e.id, name: e.name, args: e.args, status: e.status, result: e.result }
    if (i >= 0) b[i] = nb
    else b.push(nb)
  }
  return b
}

const prettyArgs = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

function ToolCard({ b }: { b: Extract<Block, { kind: 'tool' }> }) {
  const short = b.name.startsWith('mcp__') ? b.name.replace(/^mcp__(.+?)__/, '$1 · ') : b.name
  return (
    <details className="tool">
      <summary><span className={`dot ${b.status}`} /> <b style={{ color: 'var(--text)' }}>{short}</b>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.args.slice(0, 80)}</span></summary>
      <pre>{prettyArgs(b.args)}{b.result ? '\n\n' + b.result : ''}</pre>
    </details>
  )
}

export function Chat({ mode, runIdRef, hasWorkspace, onToast, onOpenSettings }: {
  mode: Mode; runIdRef: React.MutableRefObject<string>; hasWorkspace: boolean
  onToast: (s: string) => void; onOpenSettings: () => void
}) {
  const t = useT()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const runId = useRef('')

  useEffect(() => {
    return window.nova.onAgent((e) => {
      if (e.runId !== runId.current) return
      if (e.type === 'done') setBusy(false)
      else if (e.type === 'error') { setBusy(false); onToast(e.message) }
      else setTurns((ts) => {
        const c = [...ts]; const last = c[c.length - 1]
        if (last?.role === 'assistant') c[c.length - 1] = { ...last, blocks: applyEvent(last.blocks, e) }
        return c
      })
    })
  }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [turns])

  async function send(text = input) {
    if (!text.trim() || busy) return
    const history = [...turns.filter((t) => t.role === 'user' || t.text || t.blocks.length), { role: 'user' as const, text, blocks: [] }]
    setTurns([...history, { role: 'assistant', text: '', blocks: [] }])
    setInput(''); setBusy(true)
    runId.current = uid(); runIdRef.current = runId.current
    const llm = history.map((t) => ({
      role: t.role,
      content: t.role === 'user' ? t.text : t.blocks.filter((b) => b.kind === 'text').map((b: any) => b.text).join('')
    })).filter((m) => m.content)
    try { await window.nova.agentStart(runId.current, mode, llm) }
    catch (e: any) { setBusy(false); onToast(e.message); if (/Account|账户/.test(e.message)) onOpenSettings() }
  }
  const stop = () => { window.nova.agentStop(runId.current); setBusy(false) }
  const approve = async (id: string, ok: boolean) => {
    setTurns((ts) => { const c = [...ts]; const l = c[c.length - 1]; if (l) c[l ? c.length - 1 : 0] = { ...l, blocks: l.blocks.map((b) => (b.kind === 'approval' && b.id === id ? { kind: 'tool', id, name: b.name, args: b.args, status: ok ? 'running' : 'denied' } as Block : b)) }; return c })
    await window.nova.agentApprove(runId.current, id, ok)
  }

  const sugg = mode === 'code'
    ? [t('chat.sug.code1'), t('chat.sug.code2'), t('chat.sug.code3')]
    : [t('chat.sug.chat1'), t('chat.sug.chat2'), t('chat.sug.chat3')]

  return (
    <div className="chatcol">
      <div className="msgs">
        {turns.length === 0 ? (
          <div className="hero">
            <img src={logo} alt="" />
            <h1>{mode === 'code' ? t('chat.heroCode') : t('chat.heroChat')}</h1>
            {mode === 'code' && !hasWorkspace && <div>{t('chat.openWs')}</div>}
            <div className="sugs">{sugg.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        ) : (
          <div className="msgwrap">
            {turns.map((turn, i) => turn.role === 'user'
              ? <div key={i} className="msg user">{turn.text}</div>
              : <div key={i} className="msg md">
                  {turn.blocks.map((b, j) => b.kind === 'text'
                    ? <Markdown key={j} remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
                    : b.kind === 'tool' ? <ToolCard key={j} b={b} />
                    : <div key={j} className="approval">
                        <b>{t('chat.needApproval')}</b> <code>{b.name}</code>
                        <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{prettyArgs(b.args).slice(0, 1200)}</pre>
                        <div className="row"><button className="btn primary" onClick={() => approve(b.id, true)}>{t('chat.allow')}</button>
                          <button className="btn danger" onClick={() => approve(b.id, false)}>{t('chat.deny')}</button></div>
                      </div>)}
                  {busy && i === turns.length - 1 && !turn.blocks.length && <span style={{ color: 'var(--muted)' }}>{t('chat.thinking')}</span>}
                </div>)}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <div className="composer">
        <div className="compbox">
          <textarea rows={2} value={input} placeholder={mode === 'code' ? t('chat.phCode') : t('chat.phChat')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
          <div className="comprow"><span className="spacer" style={{ flex: 1 }} />
            {busy ? <button className="send" onClick={stop} title={t('chat.stop')}>■</button>
              : <button className="send" disabled={!input.trim()} onClick={() => send()} title={t('chat.send')}>↑</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
