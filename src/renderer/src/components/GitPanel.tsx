import { useCallback, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useT } from '../i18n'
import type { ConflictProposal, GitStatus, NlGitPlan } from '@shared/types'

const empty: GitStatus = { isRepo: false, branch: '', ahead: 0, behind: 0, files: [], conflicts: [] }

function Diff({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <div className="diff">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : l.startsWith('@@') ? 'h' : ''}>{l || ' '}</div>
      ))}
    </div>
  )
}

export function GitPanel({ workspace, onToast }: { workspace: string | null; onToast: (s: string) => void }) {
  const t = useT()
  const [tab, setTab] = useState<'changes' | 'nl' | 'review'>('changes')
  const [st, setSt] = useState<GitStatus>(empty)
  const [msg, setMsg] = useState('')
  const [diff, setDiff] = useState('')
  const [sel, setSel] = useState('')
  const [busy, setBusy] = useState('')
  const [props, setProps] = useState<{ file: string; list: ConflictProposal[] } | null>(null)
  const [nl, setNl] = useState('')
  const [plan, setPlan] = useState<NlGitPlan | null>(null)
  const [log, setLog] = useState('')
  const [review, setReview] = useState('')

  const refresh = useCallback(async () => { try { setSt(await window.nova.git.status()) } catch { setSt(empty) } }, [])
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t) }, [workspace, refresh])

  const wrap = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try { await fn() } catch (e: any) { onToast(e.message) } finally { setBusy(''); refresh() }
  }
  const show = (f: string, staged: boolean) => wrap('diff', async () => { setSel(f); setDiff(await window.nova.git.diff(f, staged)) })
  const stagedAny = st.files.some((f) => f.index !== ' ' && f.index !== '?')

  if (!workspace) return <div className="pane" style={{ color: 'var(--muted)' }}>{t('git.openWs')}</div>
  if (!st.isRepo) return <div className="pane" style={{ color: 'var(--muted)' }}>{t('git.notRepo')}</div>

  return (
    <>
      <div className="tabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>{t('git.tab.changes')} {st.files.length || ''}</button>
        <button className={tab === 'nl' ? 'on' : ''} onClick={() => setTab('nl')}>{t('git.tab.nl')}</button>
        <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>{t('git.tab.review')}</button>
      </div>
      <div className="pane">
        {tab === 'changes' && (
          <>
            <div style={{ color: 'var(--muted)', marginBottom: 8 }}>⎇ <b style={{ color: 'var(--text)' }}>{st.branch}</b>
              {st.ahead ? ` ↑${st.ahead}` : ''}{st.behind ? ` ↓${st.behind}` : ''}</div>

            {st.conflicts.length > 0 && (
              <div className="card" style={{ borderColor: 'var(--bad)' }}>
                <b style={{ color: 'var(--bad)' }}>⚠ {t('git.conflicts', { n: st.conflicts.length })}</b>
                {st.conflicts.map((f) => (
                  <div key={f} className="file"><span className="nm">{f}</span>
                    <button className="btn" disabled={!!busy} onClick={() => wrap('c' + f, async () => setProps({ file: f, list: await window.nova.git.conflictPropose(f) }))}>
                      {busy === 'c' + f ? t('git.analyzing') : t('git.aiResolve')}</button></div>
                ))}
              </div>
            )}
            {props && (
              <div className="card">
                <b>{t('git.proposal', { file: props.file })}</b>
                {props.list.map((p) => (
                  <div key={p.index} style={{ marginTop: 8 }}>
                    <div className="note" style={{ color: 'var(--muted)' }}>#{p.index + 1} {p.reason}</div>
                    <pre style={{ background: '#0a0714', padding: 8, borderRadius: 8, overflow: 'auto', maxHeight: 160 }}>{p.resolved}</pre>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn primary" onClick={() => wrap('apply', async () => { await window.nova.git.conflictApply(props.file, props.list); setProps(null); onToast(t('git.applied')) })}>{t('git.applyStage')}</button>
                  <button className="btn" onClick={() => setProps(null)}>{t('git.discard')}</button>
                </div>
              </div>
            )}

            {st.files.length === 0 && <div style={{ color: 'var(--muted)' }}>{t('git.clean')}</div>}
            {st.files.map((f) => {
              const staged = f.index !== ' ' && f.index !== '?'
              return (
                <div key={f.path} className="file">
                  <span className="st">{f.index === '?' ? 'U' : (f.index !== ' ' ? f.index : f.worktree)}</span>
                  <span className="nm" title={f.path} onClick={() => show(f.path, staged)}>{f.path}</span>
                  <button className="chip" onClick={() => wrap('stage', async () => { await window.nova.git.stage([f.path], !staged) })}>{staged ? t('git.unstage') : t('git.stage')}</button>
                </div>
              )
            })}
            {sel && <Diff text={diff} />}

            <div className="field" style={{ marginTop: 14 }}>
              <label>{t('git.commitMsg')}</label>
              <textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="feat(scope): subject" />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" disabled={!!busy} onClick={() => wrap('gen', async () => setMsg(await window.nova.git.commitMessage()))}>{busy === 'gen' ? t('git.generating') : t('git.aiGen')}</button>
                <button className="btn primary" disabled={!msg.trim() || !stagedAny || !!busy} onClick={() => wrap('commit', async () => { await window.nova.git.commit(msg); setMsg(''); setSel(''); onToast(t('git.committed')) })}>{t('git.commit')}</button>
              </div>
            </div>
          </>
        )}

        {tab === 'nl' && (
          <>
            <div className="field"><label>{t('git.nlLabel')}</label>
              <textarea rows={3} value={nl} onChange={(e) => setNl(e.target.value)} placeholder={t('git.nlPh')} /></div>
            <button className="btn primary" disabled={!nl.trim() || !!busy} onClick={() => wrap('plan', async () => { setLog(''); setPlan(await window.nova.git.plan(nl)) })}>{busy === 'plan' ? t('git.planning') : t('git.genCmds')}</button>
            {plan && (
              <div className="card">
                <div>{plan.explanation}</div>
                <div style={{ margin: '8px 0' }}>{t('git.risk')}<span className={`tag ${plan.risk === 'high' ? 'error' : plan.risk === 'low' ? 'ready' : ''}`}>{plan.risk}</span></div>
                <pre style={{ background: '#0a0714', padding: 8, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{plan.commands.join('\n') || t('git.noCmds')}</pre>
                {plan.commands.length > 0 && (
                  <button className={`btn ${plan.risk === 'high' ? 'danger' : 'primary'}`} disabled={!!busy}
                    onClick={() => { if (plan.risk === 'high' && !confirm(t('git.confirmHigh'))) return; wrap('run', async () => setLog(await window.nova.git.run(plan.commands))) }}>
                    {plan.risk === 'high' ? t('git.runHigh') : t('git.run')}</button>)}
                {log && <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{log}</pre>}
              </div>
            )}
          </>
        )}

        {tab === 'review' && (
          <>
            <button className="btn primary" disabled={!!busy} onClick={() => wrap('review', async () => setReview(await window.nova.git.review()))}>{busy === 'review' ? t('git.reviewing') : t('git.reviewBtn')}</button>
            <div className="md review" style={{ marginTop: 12 }}><Markdown remarkPlugins={[remarkGfm]}>{review}</Markdown></div>
          </>
        )}
      </div>
    </>
  )
}
