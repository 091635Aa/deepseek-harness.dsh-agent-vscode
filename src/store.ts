/**
 * In-memory transcript model + JSON history persistence. One SessionRecord
 * per SDK session id: messages (user / assistant / tool cards / notices),
 * todo list, title, and the model route it ran on. History is written to a
 * caller-provided JSON file (debounced by the controller).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ToolCard {
  callId: string
  name: string
  args: string
  resultText?: string
  isError?: boolean
  startTime: number
  endTime?: number
}

export type MessageStatus =
  | 'streaming'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'max-tokens'

export interface MsgEntry {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  time: number
  seq?: number
  text?: string
  reasoning?: string
  toolCalls?: ToolCard[]
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
  status?: MessageStatus
  error?: string
  noticeKind?: 'subagent-start' | 'subagent-end' | 'info' | 'compaction'
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface SessionRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  running: boolean
  closed: boolean
  messages: MsgEntry[]
  todos: TodoItem[]
}

export interface PersistedHistory {
  version: 1
  sessions: SessionRecord[]
}

export class SessionStore {
  readonly sessions = new Map<string, SessionRecord>()
  activeId?: string

  constructor(private readonly historyFile?: string) {
    if (historyFile !== undefined && fs.existsSync(historyFile)) {
      this.load(historyFile)
    }
  }

  private load(file: string): void {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as PersistedHistory
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const s of parsed.sessions) {
        if (typeof s.id !== 'string' || !Array.isArray(s.messages)) continue
        this.sessions.set(s.id, {
          id: s.id,
          title: typeof s.title === 'string' ? s.title : '',
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
          model: typeof s.model === 'string' ? s.model : '',
          running: false,
          closed: true, // a restored session belongs to a dead runtime
          messages: s.messages,
          todos: Array.isArray(s.todos) ? s.todos : [],
        })
      }
    } catch {
      // unreadable/corrupt history is not fatal
    }
  }

  createSession(model: string): SessionRecord {
    const rec: SessionRecord = {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      running: false,
      closed: false,
      messages: [],
      todos: [],
    }
    this.sessions.set(rec.id, rec)
    this.activeId = rec.id
    return rec
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id)
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      s.closed = true
      s.running = false
    }
  }

  delete(id: string): void {
    this.sessions.delete(id)
    if (this.activeId === id) this.activeId = undefined
  }

  touch(rec: SessionRecord): void {
    rec.updatedAt = Date.now()
  }

  persist(): void {
    if (this.historyFile === undefined) return
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true })
      const data: PersistedHistory = { version: 1, sessions: this.list() }
      const tmp = `${this.historyFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, this.historyFile)
    } catch {
      // persistence is best-effort; a full disk must not kill the chat
    }
  }
}
