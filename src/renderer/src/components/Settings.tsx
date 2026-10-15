import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { Accounts } from './Login'
import type { McpServerConfig, McpStatus, Settings, SkillInfo } from '@shared/types'

type Tab = 'account' | 'model' | 'mcp' | 'skills' | 'general'

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={`switch ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} />
}

export function SettingsModal({ settings, onChange, onClose, onToast }: {
  settings: Settings; onChange: (s: Settings) => void; onClose: () => void; onToast: (s: string) => void
}) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('account')
  const [mcpSt, setMcpSt] = useState<McpStatus[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [json, setJson] = useState('')
  const [syncing, setSyncing] = useState(false)

  const save = async (p: Partial<Settings>) => onChange(await window.nova.setSettings(p))
  useEffect(() => { window.nova.mcpStatus().then(setMcpSt); window.nova.listSkills().then(setSkills) }, [settings.workspace, settings.extraSkillDirs])

  const prov = settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]
  const setProv = (id: string, patch: Partial<typeof prov>) =>
    save({ providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  const setMcp = (id: string, patch: Partial<McpServerConfig>) =>
    save({ mcpServers: settings.mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)) })

  async function applyMcp() {
    setSyncing(true)
    try { setMcpSt(await window.nova.mcpSync()) } catch (e: any) { onToast(e.message) } finally { setSyncing(false) }
  }

  const NavBtn = ({ t: id, label }: { t: Tab; label: string }) =>
    <button className={`sidebtn ${tab === id ? 'on' : ''}`} style={{ width: 'calc(100% - 20px)' }} onClick={() => setTab(id)}>{label}</button>

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <nav>
          <div className="brand" style={{ padding: '6px 16px 12px' }}>{t('set.title')}</div>
          <NavBtn t="account" label={t('set.tab.account')} /><NavBtn t="model" label={t('set.tab.model')} /><NavBtn t="mcp" label={t('set.tab.mcp')} /><NavBtn t="skills" label={t('set.tab.skills')} /><NavBtn t="general" label={t('set.tab.general')} />
        </nav>
        <div className="content">
          {tab === 'account' && (
            <>
              <h2>{t('set.tab.account')}</h2>
              <Accounts settings={settings} onChange={onChange} onToast={onToast} variant="tab" />
            </>
          )}

          {tab === 'model' && (
            <>
              <h2>{t('set.gateway')}</h2>
              <div className="field"><label>{t('set.provider')}</label>
                <select value={prov.id} onChange={(e) => { const p = settings.providers.find((x) => x.id === e.target.value)!; save({ activeProviderId: p.id, activeModel: p.models[0] }) }}>
                  {settings.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              {prov.kind !== 'codex' && <div className="field"><label>Base URL</label><input value={prov.baseUrl} onChange={(e) => setProv(prov.id, { baseUrl: e.target.value })} /></div>}
              {prov.kind !== 'codex' && <div className="field"><label>{t('set.apiKeyLabel')}</label><input type="password" value={prov.apiKey} placeholder="sk-…" onChange={(e) => setProv(prov.id, { apiKey: e.target.value })} /></div>}
              <div className="field"><label>{t('set.modelsLabel')}</label>
                <input value={prov.models.join(', ')} onChange={(e) => setProv(prov.id, { models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></div>
              <div className="field"><label>{t('set.useModel')}</label>
                <select value={settings.activeModel} onChange={(e) => save({ activeModel: e.target.value })}>
                  {prov.models.map((m) => <option key={m}>{m}</option>)}</select></div>
              <div className="note" style={{ color: 'var(--muted)' }}>{t('set.gatewayNote')}</div>
            </>
          )}

          {tab === 'mcp' && (
            <>
              <h2>{t('set.mcp')}</h2>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <button className="btn primary" onClick={applyMcp} disabled={syncing}>{syncing ? t('set.mcpConnecting') : t('set.mcpApply')}</button>
              </div>
              {settings.mcpServers.map((s) => {
                const st = mcpSt.find((x) => x.id === s.id)
                return (
                  <div className="card" key={s.id}>
                    <div className="h"><b>{s.name}</b><span className="tag">{s.transport}</span>
                      <span className={`tag ${st?.state === 'ready' ? 'ready' : st?.state === 'error' ? 'error' : ''}`}>
                        {st?.state === 'ready' ? t('set.mcpReady', { n: st.tools.length }) : st?.state === 'error' ? t('set.mcpFailed') : t('set.mcpOff')}</span>
                      <span className="spacer" style={{ flex: 1 }} /><Switch on={s.enabled} onClick={() => setMcp(s.id, { enabled: !s.enabled })} /></div>
                    {s.preset && t('mcpnote.' + s.preset) !== 'mcpnote.' + s.preset ? <div className="note">{t('mcpnote.' + s.preset)}</div> : s.note && <div className="note">{s.note}</div>}
                    {st?.error && <div className="note" style={{ color: 'var(--bad)' }}>{st.error.slice(0, 300)}</div>}
                    {s.transport === 'http' && <div className="field"><label>URL</label><input value={s.url ?? ''} onChange={(e) => setMcp(s.id, { url: e.target.value })} />
                      <label>Authorization</label><input type="password" value={s.headers?.Authorization ?? ''} onChange={(e) => setMcp(s.id, { headers: { ...s.headers, Authorization: e.target.value } })} /></div>}
                    {s.transport === 'stdio' && <div className="field"><label>{t('set.command')}</label>
                      <input value={[s.command, ...(s.args ?? [])].join(' ')} onChange={(e) => { const [c, ...a] = e.target.value.split(/\s+/); setMcp(s.id, { command: c, args: a }) }} /></div>}
                  </div>
                )
              })}
              <div className="field"><label>{t('set.mcpImport')}</label>
                <textarea rows={4} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"mcpServers":{"name":{"command":"npx","args":["-y","pkg"]}}}' />
                <button className="btn" disabled={!json.trim()} onClick={async () => { try { onChange(await window.nova.mcpImportJson(json)); setJson(''); onToast(t('set.imported')) } catch (e: any) { onToast(t('set.jsonInvalid', { msg: e.message })) } }}>{t('set.import')}</button></div>
            </>
          )}

          {tab === 'skills' && (
            <>
              <h2>{t('set.skills')}</h2>
              <div className="note" style={{ color: 'var(--muted)', marginBottom: 8 }}>
                <span dangerouslySetInnerHTML={{ __html: t('set.skillsNote') }} /></div>
              <button className="btn" onClick={async () => onChange(await window.nova.addSkillDir())}>{t('set.addSkillDir')}</button>
              {settings.extraSkillDirs.map((d) => <div key={d} className="note" style={{ color: 'var(--muted)' }}>{d}</div>)}
              {skills.length === 0 && <div className="card">{t('set.noSkills')}</div>}
              {skills.map((s) => <div className="card" key={s.name}><div className="h"><b>{s.name}</b><span className="tag">{s.source}</span></div><div className="note">{s.description}</div></div>)}
            </>
          )}

          {tab === 'general' && (
            <>
              <h2>{t('set.general')}</h2>
              <div className="card"><div className="h"><b>{t('set.language')}</b><span style={{ flex: 1 }} />
                <div className="seg"><button className={settings.language === 'zh' ? 'on' : ''} onClick={() => save({ language: 'zh' })}>中文</button><button className={settings.language === 'en' ? 'on' : ''} onClick={() => save({ language: 'en' })}>English</button></div></div></div>
              <div className="card"><div className="h"><b>{t('set.autoApprove')}</b><span className="spacer" style={{ flex: 1 }} /><Switch on={settings.autoApprove} onClick={() => save({ autoApprove: !settings.autoApprove })} /></div>
                <div className="note">{t('set.autoApproveNote')}</div></div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
