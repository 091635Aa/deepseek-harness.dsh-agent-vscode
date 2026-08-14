/**
 * Newline-delimited JSON-RPC 2.0 client over a child process stdio pair, plus
 * the DeepSeek Harness SDK wire shapes the extension speaks. The wire contract
 * mirrors `@deepseek-ai/dsh-sdk-protocol` (one compact JSON frame per
 * `\n`-terminated line; stdout of the child carries ONLY protocol frames).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type NotificationHandler = (method: string, params: unknown) => void

export class JsonRpcResponseError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(`JSON-RPC error ${code}: ${message}`)
    this.name = 'JsonRpcResponseError'
    this.code = code
    this.data = data
  }
}

/**
 * Line-framed JSON-RPC client. Requests are correlated by id; notifications
 * dispatch to a single handler. Malformed lines are ignored, matching the
 * protocol transport contract.
 */
export class LineJsonRpcClient {
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly onNotification: NotificationHandler,
  ) {
    this.input.setEncoding('utf8')
    this.input.on('data', (chunk: string) => this.onData(chunk))
    this.input.on('end', () => this.rejectAll(new Error('protocol transport closed')))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        continue // malformed line: ignore, per protocol
      }
      this.dispatch(frame)
    }
  }

  private dispatch(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return
    const f = frame as Record<string, unknown>
    if (typeof f.method === 'string' && typeof f.id === 'number') {
      // request from server — the harness server never sends these today
      return
    }
    if (typeof f.method === 'string') {
      const params = f.params
      this.onNotification(f.method, params)
      return
    }
    if (typeof f.id === 'number') {
      const entry = this.pending.get(f.id)
      if (!entry) return
      this.pending.delete(f.id)
      const resp = f as unknown as JsonRpcResponse
      if (resp.error !== undefined) {
        entry.reject(new JsonRpcResponseError(resp.error.code, resp.error.message, resp.error.data))
      } else {
        entry.resolve(resp.result)
      }
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC client is closed'))
    const id = this.nextId++
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method }
    if (params !== undefined) frame.params = params
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.output.write(JSON.stringify(frame) + '\n')
    })
  }

  private rejectAll(err: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }

  dispose(): void {
    this.rejectAll(new Error('JSON-RPC client disposed'))
    this.input.removeAllListeners()
  }
}

/* ------------------------------------------------------------------ */
/* SDK wire shapes                                                      */
/* ------------------------------------------------------------------ */

export interface InitializeParams {
  cwd: string
  provider: string
  model: string
  maxTokens?: number
}

export interface InitializeResult {
  serverInfo: { name: string; version: string }
}

export interface SessionPromptParams {
  sessionId: string
  contentBlocks: { type: 'text'; text: string }[]
}

export interface SessionPromptResult {
  messageId: string
}

/** One session-log event envelope as streamed by `session.event`. */
export interface SessionEventEnvelope {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  ignorable?: boolean
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

export interface SessionEventNotification {
  sessionId: string
  event: SessionEventEnvelope
}

export interface SessionStatusNotification {
  sessionId: string
  status: 'idle' | 'running'
}

export interface SubagentStartedNotification {
  parentSessionId: string
  childSessionId: string
}

export interface SubagentFinishedNotification {
  provider: string
  agentId: string
  parentSessionId: string
  childSessionId: string
  status: 'ok' | 'error'
  stopReason: { kind: string }
  lastAssistantMessage?: unknown[]
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export const SDK_SERVER_INFO_NAME = 'deepseek-harness-sdk-runtime'
