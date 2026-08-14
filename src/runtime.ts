/**
 * Manages the child DeepSeek Harness runtime process: resolve where it lives,
 * write the runtime composition, spawn `dsh-jsonrpc-agent`, run the SDK
 * `initialize` handshake, stream notifications, and restart after crashes.
 *
 * The child owns real credentials and full workspace access; it is spawned
 * from the user's machine exactly like the harness desktop app would run it.
 */

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { LineJsonRpcClient } from './protocol'
import type { ModelSelection } from './models'

export const RUNTIME_MARKER = 'packages/examples/jsonrpc-demo'

export interface RuntimeCallbacks {
  onEvent: (sessionId: string, event: unknown) => void
  onStatus: (sessionId: string, status: 'idle' | 'running') => void
  onSubagentStarted: (parentSessionId: string, childSessionId: string) => void
  onSubagentFinished: (parentSessionId: string, childSessionId: string, status: string) => void
  onExit: (code: number | null, unexpected: boolean, stderrTail: string) => void
  onLog: (line: string) => void
}

export interface RuntimeSettings {
  repoPath: string
  configPath: string
  sessionRoot: string
  extraEnv: Record<string, string>
  command: string
  extraArgs: string[]
  autoRestart: boolean
}

/** Locate the harness checkout: explicit setting, env, then workspace probe. */
export function resolveRepoPath(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): string {
  const fromSetting = vscode.workspace.getConfiguration('dshAgent').get<string>('repoPath') ?? ''
  if (fromSetting.trim() !== '') return fromSetting.trim()
  const fromEnv = process.env.DSH_REPO_PATH
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  for (const folder of workspaceFolders ?? []) {
    const candidate = folder.uri.fsPath
    if (fs.existsSync(path.join(candidate, RUNTIME_MARKER, 'lib', 'bin.js'))) return candidate
    if (fs.existsSync(path.join(candidate, RUNTIME_MARKER, 'src', 'bin.ts'))) return candidate
  }
  return ''
}

export interface LaunchPlan {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  error?: string
}

export function buildLaunchPlan(
  settings: RuntimeSettings,
  repoPath: string,
  configPath: string,
  workspace: string,
  persona: string,
  model: ModelSelection,
  maxTokens: number | undefined,
  sessionRoot: string,
): LaunchPlan {
  const builtBin = path.join(repoPath, RUNTIME_MARKER, 'lib', 'bin.js')
  const srcBin = path.join(repoPath, RUNTIME_MARKER, 'src', 'bin.ts')
  let args: string[]
  if (fs.existsSync(builtBin)) {
    args = [builtBin, configPath]
  } else if (fs.existsSync(srcBin)) {
    args = ['--import', 'tsx/esm', srcBin, configPath]
  } else {
    return {
      command: settings.command,
      args: [],
      cwd: repoPath,
      env: {},
      error:
        `未找到 jsonrpc 运行时入口（${RUNTIME_MARKER}/lib/bin.js 或 src/bin.ts）。` +
        '请检查 dshAgent.repoPath 设置，或先构建仓库（pnpm run build）。',
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_CWD: workspace,
    DSH_SYSTEM_PROMPT: persona,
    DSH_SESSION_ROOT: sessionRoot,
    ...settings.extraEnv,
  }
  return { command: settings.command, args: [...args, ...settings.extraArgs], cwd: repoPath, env }
}

/** Write the built-in composition into the repo's examples resolution tree so bare plugins resolve, or honor a custom path. */
export function resolveRuntimeConfig(mediaDir: string, repoPath: string, customPath: string): string {
  if (customPath.trim() !== '') {
    if (!fs.existsSync(customPath)) {
      throw new Error(`dshAgent.configPath 不存在: ${customPath}`)
    }
    return customPath
  }
  // The config lives inside examples/jsonrpc-agent so Node's ancestor walk
  // reaches examples/node_modules, where the dsh-examples workspace links the
  // bare plugin packages named by the composition.
  const target = path.join(repoPath, 'examples', 'jsonrpc-agent', 'vscode-agent.cordis.yml')
  const src = path.join(mediaDir, 'cordis.yml')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const bundled = fs.readFileSync(src, 'utf8')
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    if (existing !== bundled) fs.writeFileSync(target, bundled, 'utf8')
  } catch (err) {
    throw new Error(`写入运行时配置失败: ${String(err)}`)
  }
  return target
}

export class HarnessRuntime {
  private child?: childProcess.ChildProcess
  private client?: LineJsonRpcClient
  private stderrTail = ''
  private userStopped = false
  private restartTimer?: NodeJS.Timeout
  private restartAttempts = 0
  ready = false
  readonly cwd: string

  constructor(
    readonly repoPath: string,
    readonly configPath: string,
    readonly workspace: string,
    readonly model: ModelSelection,
    readonly maxTokens: number | undefined,
    readonly settings: RuntimeSettings,
    readonly sessionRoot: string,
    private readonly cb: RuntimeCallbacks,
  ) {
    this.cwd = workspace
  }

  private personaText(): string {
    return vscode.workspace.getConfiguration('dshAgent').get<string>('systemPrompt') ?? ''
  }

  get running(): boolean {
    return this.child !== undefined && this.ready
  }

  private log(line: string): void {
    this.cb.onLog(line)
  }

  async start(): Promise<void> {
    if (this.ready) return
    this.userStopped = false
    this.restartAttempts = 0
    await this.spawnOnce()
  }

  private async spawnOnce(): Promise<void> {
    const plan = buildLaunchPlan(
      this.settings,
      this.repoPath,
      this.configPath,
      this.workspace,
      this.personaText(),
      this.model,
      this.maxTokens,
      this.sessionRoot,
    )
    if (plan.error !== undefined) {
      throw new Error(plan.error)
    }
    this.log(`启动运行时: ${plan.command} ${plan.args.join(' ')}`)
    this.stderrTail = ''
    const child = childProcess.spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    const tail: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      tail.push(chunk)
      if (tail.join('').length > 32768) tail.shift()
      this.stderrTail = tail.join('')
      const lines = chunk.split(/\r?\n/).filter(Boolean)
      for (const line of lines.slice(-5)) this.log(`[runtime] ${line}`)
    })

    if (child.stdin === null || child.stdout === null) {
      child.kill()
      throw new Error('运行时 stdio 不可用')
    }
    const client = new LineJsonRpcClient(child.stdout, child.stdin, (method, params) => {
      this.dispatchNotification(method, params)
    })
    this.client = client

    const exitHandler = (code: number | null): void => {
      client.dispose()
      this.ready = false
      const unexpected = !this.userStopped
      this.cb.onExit(code, unexpected, this.stderrTail)
      if (unexpected && this.settings.autoRestart && this.restartAttempts < 5) {
        const delay = Math.min(1000 * 2 ** this.restartAttempts, 15000)
        this.restartAttempts += 1
        this.log(`运行时退出（code=${String(code)}），${delay}ms 后自动重启…`)
        this.restartTimer = setTimeout(() => {
          void this.spawnOnce().catch((err) => this.log(`自动重启失败: ${String(err)}`))
        }, delay)
      }
    }
    child.once('exit', exitHandler)
    child.once('error', (err) => {
      this.log(`运行时进程错误: ${String(err)}`)
      this.cb.onExit(-1, true, `${this.stderrTail}\n${String(err)}`)
    })

    const timeoutMs = 90000
    const result = await withTimeout(
      client.request<{ serverInfo: { name: string; version: string } }>('initialize', {
        cwd: this.workspace,
        provider: this.model.provider,
        model: this.model.model,
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      }),
      timeoutMs,
      '运行时初始化超时（90s）——请检查 DSH_HOME 凭据、API 网络或 stderr 输出',
    )
    this.ready = true
    this.log(`运行时就绪: ${result.serverInfo.name}@${result.serverInfo.version}（${this.model.model}）`)
  }

  private dispatchNotification(method: string, params: unknown): void {
    try {
      switch (method) {
        case 'session.event': {
          const p = params as { sessionId: string; event: unknown }
          this.cb.onEvent(p.sessionId, p.event)
          break
        }
        case 'session.status': {
          const p = params as { sessionId: string; status: 'idle' | 'running' }
          this.cb.onStatus(p.sessionId, p.status)
          break
        }
        case 'subagent.started': {
          const p = params as { parentSessionId: string; childSessionId: string }
          this.cb.onSubagentStarted(p.parentSessionId, p.childSessionId)
          break
        }
        case 'subagent.finished': {
          const p = params as { parentSessionId: string; childSessionId: string; status: string }
          this.cb.onSubagentFinished(p.parentSessionId, p.childSessionId, p.status)
          break
        }
        default:
          break
      }
    } catch (err) {
      this.log(`处理通知 ${method} 失败: ${String(err)}`)
    }
  }

  async sendPrompt(sessionId: string, text: string): Promise<string> {
    if (!this.ready || this.child === undefined || this.client === undefined) {
      throw new Error('运行时未就绪')
    }
    const result = await this.client.request<{ messageId: string }>('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
    return result.messageId
  }

  /** Stop the child (protocol `shutdown`, then kill ladder). User-initiated. */
  async stop(): Promise<void> {
    this.userStopped = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    const client = this.client
    this.ready = false
    this.child = undefined
    this.client = undefined
    if (child === undefined || child.exitCode !== null) return
    try {
      if (client !== undefined) {
        await withTimeout(client.request('shutdown'), 3000, 'shutdown 超时')
      }
    } catch {
      // fall through to kill
    }
    if (child.exitCode === null) {
      if (child.stdin !== null) child.stdin.end()
      await waitExit(child, 2500)
    }
    if (child.exitCode === null) child.kill()
  }

  /** Hard-kill without protocol shutdown (crash-cleanup path). */
  kill(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.userStopped = true
    this.ready = false
    const child = this.child
    this.child = undefined
    this.client?.dispose()
    this.client = undefined
    if (child !== undefined && child.exitCode === null) child.kill()
  }

  dispose(): void {
    this.kill()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

function waitExit(child: childProcess.ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, ms)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
