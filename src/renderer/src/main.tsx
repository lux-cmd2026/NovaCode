import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Mode, Settings } from '@shared/types'
import { Chat } from './components/Chat'
import { GitPanel } from './components/GitPanel'
import { SettingsModal } from './components/Settings'
import { LoginPage } from './components/Login'
import { LangContext, useT } from './i18n'
import logo from './assets/logo.png'
import './styles.css'

const isMac = navigator.userAgent.includes('Mac')

function Shell({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const t = useT()
  const [mode, setMode] = useState<Mode>('code')
  const [showGit, setShowGit] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [toast, setToast] = useState('')
  const [chatKey, setChatKey] = useState(0)
  const runIdRef = useRef('')

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const wsName = s.workspace ? s.workspace.split(/[\\/]/).filter(Boolean).pop() : t('app.noWorkspace')

  return (
    <div className={`app ${isMac ? 'mac' : ''}`}>
      <aside className="side">
        <div className="brand drag"><img src={logo} alt="" /> NovaCode</div>
        <button className="sidebtn nodrag" onClick={() => setChatKey((k) => k + 1)}>{t('app.newChat')}</button>
        <div className="sect">{t('app.workspace')}</div>
        <button className="thread" title={s.workspace ?? ''} onClick={async () => setS(await window.nova.openWorkspace())}>📁 {wsName}</button>
        {s.recentWorkspaces.filter((w) => w !== s.workspace).slice(0, 5).map((w) => (
          <button key={w} className="thread" title={w} onClick={async () => setS(await window.nova.setSettings({ workspace: w }))}>{w.split(/[\\/]/).filter(Boolean).pop()}</button>
        ))}
        <div className="grow" />
        <div className="sidefoot">
          <button className="sidebtn" style={{ margin: 0, width: '100%' }} onClick={() => setShowSettings(true)}>{t('app.settings')}</button>
          <div style={{ color: 'var(--muted)', fontSize: 12, padding: '6px 10px' }} title={s.activeProviderId}>{s.providers.find((p) => p.id === s.activeProviderId)?.name} · {s.activeModel}</div>
        </div>
      </aside>

      <section className="main">
        <header className="top drag">
          <div className="seg nodrag">
            <button className={mode === 'chat' ? 'on' : ''} onClick={() => setMode('chat')}>NovaChat</button>
            <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>NovaCode</button>
          </div>
          <span className="spacer" />
          {mode === 'code' && <button className="chip nodrag" onClick={() => setShowGit((v) => !v)}>{t('app.gitPanel')}</button>}
        </header>
        <div className="body">
          <Chat key={chatKey + mode} mode={mode} runIdRef={runIdRef} hasWorkspace={!!s.workspace} onToast={say} onOpenSettings={() => setShowSettings(true)} />
          {mode === 'code' && showGit && <aside className="right"><GitPanel workspace={s.workspace} onToast={say} /></aside>}
        </div>
      </section>

      {showSettings && <SettingsModal settings={s} onChange={setS} onClose={() => setShowSettings(false)} onToast={say} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function App() {
  const [s, setS] = useState<Settings | null>(null)
  const [toast, setToast] = useState('')
  useEffect(() => { window.nova.getSettings().then(setS) }, [])
  if (!s) return null
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }
  const setLang = async (language: 'zh' | 'en') => setS(await window.nova.setSettings({ language }))
  document.documentElement.lang = s.language === 'zh' ? 'zh-CN' : 'en'
  return (
    <LangContext.Provider value={s.language}>
      {s.onboarded
        ? <Shell s={s} setS={setS} />
        : <>
            <LoginPage settings={s} onChange={setS} onToast={say} onLang={setLang}
              onContinue={async () => setS(await window.nova.setSettings({ onboarded: true }))} />
            {toast && <div className="toast">{toast}</div>}
          </>}
    </LangContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
