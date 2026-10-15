import { useEffect, useState } from 'react'
import type { ProviderAuth, Settings } from '@shared/types'
import { useT } from '../i18n'
import logo from '../assets/logo.png'

type Props = {
  settings: Settings
  onChange: (s: Settings) => void
  onToast: (m: string) => void
  /** login page (full screen) vs. settings tab */
  variant: 'page' | 'tab'
  onContinue?: () => void
}

const ORDER = ['chatgpt', 'anthropic', 'xai'] as const
const META: Record<string, { name: string; desc: string; glyph: string }> = {
  chatgpt: { name: 'login.chatgpt', desc: 'login.chatgptDesc', glyph: '◎' },
  anthropic: { name: 'login.claude', desc: 'login.claudeDesc', glyph: '✺' },
  xai: { name: 'login.grok', desc: 'login.grokDesc', glyph: '✕' }
}

export function Accounts({ settings, onChange, onToast, variant, onContinue }: Props) {
  const t = useT()
  const [auth, setAuth] = useState<ProviderAuth[]>([])
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [waiting, setWaiting] = useState<string | null>(null) // authorize URL while the browser flow runs

  const refresh = async () => setAuth(await window.nova.auth.list())
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    const a = window.nova.auth.onChanged(async () => {
      setWaiting(null); setBusy('')
      setAuth(await window.nova.auth.list()); onChange(await window.nova.getSettings()); onToast(t('login.chatgptOk'))
    })
    const b = window.nova.auth.onError((m) => { setWaiting(null); setBusy(''); onToast(m) })
    return () => { a(); b() }
  }, [])

  const get = (id: string) => auth.find((a) => a.id === id)
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try { await fn() } catch (e: any) { onToast(e.message) } finally { setBusy((b) => (b === label ? '' : b)) }
  }

  const startBrowser = () => run('chatgpt', async () => {
    const { url } = await window.nova.auth.codexStart()
    setWaiting(url)
  })
  const cancelBrowser = async () => { await window.nova.auth.codexCancel(); setWaiting(null); setBusy('') }
  const importCodex = () => run('import', async () => {
    setAuth(await window.nova.auth.codexImport()); onChange(await window.nova.getSettings()); onToast(t('login.chatgptOk'))
  })
  const saveKey = (id: string) => run(id, async () => {
    const r = await window.nova.auth.setKey(id, keys[id] ?? '')
    onChange(r.settings); setKeys((k) => ({ ...k, [id]: '' })); await refresh()
    onToast(t('login.keySaved', { name: t(META[id].name), n: r.count }))
  })
  const signOut = (id: string) => run('out' + id, async () => {
    if (id === 'chatgpt') setAuth(await window.nova.auth.codexLogout())
    else { onChange(await window.nova.auth.removeKey(id)); await refresh() }
    onChange(await window.nova.getSettings()); onToast(t('login.signedOutToast'))
  })
  const use = (id: string) => run('use' + id, async () => { onChange(await window.nova.auth.use(id)) })

  const anyConnected = auth.some((a) => a.connected)

  return (
    <div className={variant === 'page' ? 'login-cards' : ''}>
      {ORDER.map((id) => {
        const a = get(id)
        const m = META[id]
        const inUse = settings.activeProviderId === id
        return (
          <div className={`card acct ${a?.connected ? 'on' : ''}`} key={id} data-acct={id}>
            <div className="h">
              <span className="glyph">{m.glyph}</span>
              <b>{t(m.name)}</b>
              {a?.connected && <span className="tag ready">{t('login.connected')}</span>}
              {a?.connected && inUse && <span className="tag">{t('login.inUse')}</span>}
              <span style={{ flex: 1 }} />
              {a?.connected && !inUse && <button className="btn" onClick={() => use(id)}>{t('login.useThis')}</button>}
              {a?.connected && <button className="btn danger" disabled={busy === 'out' + id} onClick={() => signOut(id)}>{t('login.signOut')}</button>}
            </div>
            <div className="note">{t(m.desc)}</div>
            {a?.connected && a.detail && <div className="note acct-detail">{a.detail}{id === 'chatgpt' && a.source === 'cli' ? ` · ${t('login.cliShared')}` : ''}</div>}

            {id === 'chatgpt' && !a?.connected && (
              waiting ? (
                <div className="waiting">
                  <div className="note"><span className="dot running" /> {t('login.waiting')}</div>
                  <div className="row">
                    <button className="btn" onClick={() => window.nova.openExternal(waiting)}>{t('login.openAgain')}</button>
                    <button className="btn" onClick={async () => { await window.nova.copy(waiting); onToast(t('login.linkCopied')) }}>{t('login.copyLink')}</button>
                    <button className="btn danger" onClick={cancelBrowser}>{t('login.cancel')}</button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button className="btn primary" disabled={!!busy} onClick={startBrowser}>{t('login.signInBrowser')}</button>
                  <button className="btn" disabled={!!busy} onClick={importCodex} title={t('login.useCodexFileHint', { path: '~/.codex/auth.json' })}>{t('login.useCodexFile')}</button>
                </div>
              )
            )}

            {id !== 'chatgpt' && !a?.connected && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); saveKey(id) }}>
                <input type="password" autoComplete="off" spellCheck={false} placeholder={t('login.keyPh')} value={keys[id] ?? ''} onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))} style={{ flex: 1 }} />
                <button className="btn primary" type="submit" disabled={!!busy || !(keys[id] ?? '').trim()}>{busy === id ? t('login.verifying') : t('login.verify')}</button>
              </form>
            )}
          </div>
        )
      })}

      {variant === 'page' && (
        <div className="login-foot">
          <button className="btn primary big" disabled={!anyConnected} onClick={onContinue}>{t('login.continue')}</button>
          <button className="linkbtn" onClick={onContinue}>{t('login.skip')}</button>
        </div>
      )}
      <div className="note sec">{t('login.security')}</div>
    </div>
  )
}

export function LoginPage({ settings, onChange, onToast, onContinue, onLang }: {
  settings: Settings; onChange: (s: Settings) => void; onToast: (m: string) => void; onContinue: () => void; onLang: (l: 'zh' | 'en') => void
}) {
  const t = useT()
  return (
    <div className="login drag">
      <div className="login-lang nodrag">
        <button className={settings.language === 'zh' ? 'on' : ''} onClick={() => onLang('zh')}>中文</button>
        <button className={settings.language === 'en' ? 'on' : ''} onClick={() => onLang('en')}>English</button>
      </div>
      <div className="login-box nodrag">
        <img src={logo} alt="" width={56} height={56} />
        <h1>NovaCode</h1>
        <h2>{t('login.title')}</h2>
        <p className="sub">{t('login.subtitle')}</p>
        <Accounts settings={settings} onChange={onChange} onToast={onToast} variant="page" onContinue={onContinue} />
      </div>
    </div>
  )
}
