export type ProviderKind = 'openai' | 'anthropic' | 'codex'
export type Mode = 'chat' | 'code'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  models: string[]
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  preset?: string
  note?: string
}

export interface McpStatus {
  id: string
  state: 'off' | 'connecting' | 'ready' | 'error'
  tools: { name: string; description?: string }[]
  error?: string
}

export interface SkillInfo {
  name: string
  description: string
  source: string // e.g. "Claude", "Codex", "NovaCode", "Project"
  dir: string
  file: string
}

export interface Settings {
  providers: ProviderConfig[]
  activeProviderId: string
  activeModel: string
  mcpServers: McpServerConfig[]
  extraSkillDirs: string[]
  autoApprove: boolean
  workspace: string | null
  recentWorkspaces: string[]
  language: 'zh' | 'en'
  /** auth.json used for ChatGPT/Codex sign-in; null = NovaCode's own store. */
  codexAuthPath: string | null
  /** false until the user has passed the login page once (or skipped it). */
  onboarded: boolean
}

export type Lang = 'zh' | 'en'

export interface ProviderAuth {
  id: string
  connected: boolean
  /** e.g. email · plan for ChatGPT, or masked key */
  detail?: string
  /** ChatGPT only: 'own' = signed in inside NovaCode, 'cli' = shares the Codex CLI auth.json */
  source?: 'own' | 'cli'
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export type AgentEvent =
  | { runId: string; type: 'delta'; text: string }
  | { runId: string; type: 'tool'; id: string; name: string; args: string; status: 'running' | 'done' | 'error' | 'denied'; result?: string }
  | { runId: string; type: 'approval'; id: string; name: string; args: string }
  | { runId: string; type: 'done' }
  | { runId: string; type: 'error'; message: string }

export interface GitFile {
  path: string
  index: string // staged status char
  worktree: string // unstaged status char
}
export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
  conflicts: string[]
}

export interface ConflictProposal {
  file: string
  index: number
  resolved: string
  reason: string
}
export interface NlGitPlan {
  explanation: string
  risk: 'low' | 'medium' | 'high'
  commands: string[]
}
