import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent } from '../shared/types'

const call = async (ch: string, ...a: unknown[]) => {
  const r = await ipcRenderer.invoke(ch, ...a)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

const api = {
  getSettings: () => call('settings:get'),
  setSettings: (p: unknown) => call('settings:set', p),
  openWorkspace: () => call('workspace:open'),
  listSkills: () => call('skills:list'),
  addSkillDir: () => call('skills:addDir'),
  mcpStatus: () => call('mcp:status'),
  mcpSync: () => call('mcp:sync'),
  mcpImportJson: (t: string) => call('mcp:importJson', t),
  auth: {
    list: () => call('auth:list'),
    codexStart: () => call('auth:codexStart'),
    codexCancel: () => call('auth:codexCancel'),
    codexImport: () => call('auth:codexImport'),
    codexLogout: () => call('auth:codexLogout'),
    setKey: (id: string, key: string) => call('auth:setKey', id, key),
    removeKey: (id: string) => call('auth:removeKey', id),
    use: (id: string) => call('auth:use', id),
    onChanged: (cb: () => void) => { const h = () => cb(); ipcRenderer.on('auth:changed', h); return () => { ipcRenderer.removeListener('auth:changed', h) } },
    onError: (cb: (m: string) => void) => { const h = (_: unknown, m: string) => cb(m); ipcRenderer.on('auth:error', h); return () => { ipcRenderer.removeListener('auth:error', h) } }
  },
  copy: (text: string) => call('app:copy', text),
  openExternal: (url: string) => call('app:openExternal', url),
  agentStart: (runId: string, mode: string, history: unknown) => call('agent:start', runId, mode, history),
  agentStop: (runId: string) => call('agent:stop', runId),
  agentApprove: (runId: string, id: string, ok: boolean) => call('agent:approve', runId, id, ok),
  onAgent: (cb: (e: AgentEvent) => void) => {
    const h = (_: unknown, e: AgentEvent) => cb(e)
    ipcRenderer.on('agent:event', h)
    return () => { ipcRenderer.removeListener('agent:event', h) }
  },
  git: {
    status: () => call('git:status'),
    diff: (f: string, staged: boolean) => call('git:diff', f, staged),
    stage: (files: string[], stage: boolean) => call('git:stage', files, stage),
    commit: (m: string) => call('git:commit', m),
    commitMessage: () => call('git:commitMessage'),
    review: () => call('git:review'),
    plan: (r: string) => call('git:plan', r),
    run: (c: string[]) => call('git:run', c),
    conflictPropose: (f: string) => call('git:conflictPropose', f),
    conflictApply: (f: string, p: unknown) => call('git:conflictApply', f, p)
  }
}

contextBridge.exposeInMainWorld('nova', api)
export type NovaApi = typeof api
