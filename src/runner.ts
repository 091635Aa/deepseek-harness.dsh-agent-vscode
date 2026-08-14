/**
 * "No launch.json required" runner: run the current file with the right
 * interpreter/compiler, or a named task from `.dsh-vscode/tasks.json`.
 * Compiler output feeds VS Code problem matchers so errors land in the
 * Problems panel, like a native build integration.
 */

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

const whichCache = new Map<string, string | undefined>()

function findExecutable(names: string[]): string | undefined {
  for (const name of names) {
    if (whichCache.has(name)) {
      const hit = whichCache.get(name)
      if (hit !== undefined) return hit
      continue
    }
    try {
      const probe = process.platform === 'win32' ? 'where' : 'which'
      const out = childProcess.execFileSync(probe, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '')
      whichCache.set(name, first)
      if (first !== undefined) return first
    } catch {
      whichCache.set(name, undefined)
    }
  }
  return undefined
}

export interface RunnerResult {
  skipped: boolean
  message?: string
}

export class Runner {
  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {}

  private get buildDir(): string {
    return path.join(this.workspaceFolder?.uri.fsPath ?? process.cwd(), '.dsh-vscode', 'build')
  }

  async runFile(uri: vscode.Uri): Promise<RunnerResult> {
    const file = uri.fsPath
    const ext = path.extname(file).toLowerCase()
    const cwd = this.workspaceFolder?.uri.fsPath ?? path.dirname(file)
    const command = this.commandFor(ext, file, cwd)
    if (command === undefined) {
      const message =
        ext === '.json'
          ? 'JSON 不是可执行文件。如需“一键运行”，请用 dshAgent.runTask 定义任务，或用 launch.json 调试器。'
          : `不支持的文件类型 ${ext || '(无扩展名)'}。可用 dshAgent.runTask 定义自定义任务。`
      void vscode.window.showInformationMessage(message)
      return { skipped: true, message }
    }
    await this.execute(command.command, `运行 ${path.basename(file)}`, cwd, command.matcher)
    return { skipped: false }
  }

  private commandFor(
    ext: string,
    file: string,
    cwd: string,
  ): { command: string; matcher?: string } | undefined {
    const quote = (s: string): string => `"${s.replaceAll('"', '\\"')}"`
    switch (ext) {
      case '.py': {
        const py = findExecutable(['python', 'python3', 'py'])
        if (py === undefined) return undefined
        return { command: `${py} ${quote(file)}`, matcher: '$dsh-python' }
      }
      case '.js':
      case '.mjs':
      case '.cjs': {
        const node = findExecutable(['node'])
        if (node === undefined) return undefined
        return { command: `${node} ${quote(file)}` }
      }
      case '.ts':
      case '.tsx': {
        const node = findExecutable(['node'])
        if (node === undefined) return undefined
        // Node >= 23.6 strips types natively; tsx is a fallback.
        const tsx = findExecutable(['tsx'])
        const run = tsx !== undefined ? `${tsx} ${quote(file)}` : `${node} ${quote(file)}`
        return { command: run }
      }
      case '.sh': {
        const bash = findExecutable(['bash'])
        if (bash === undefined) return undefined
        return { command: `${bash} ${quote(file)}` }
      }
      case '.ps1': {
        const pwsh = findExecutable(['pwsh', 'powershell'])
        if (pwsh === undefined) return undefined
        return { command: `${pwsh} -File ${quote(file)}` }
      }
      case '.c':
      case '.cpp':
      case '.cc':
      case '.cxx': {
        const compiler = findExecutable(['g++', 'gcc', 'clang++', 'clang'])
        if (compiler === undefined) return undefined
        fs.mkdirSync(this.buildDir, { recursive: true })
        const exe = path.join(this.buildDir, `${path.basename(file, ext)}.exe`)
        return {
          command: `${compiler} ${quote(file)} -o ${quote(exe)} && ${quote(exe)}`,
          matcher: '$dsh-gcc',
        }
      }
      case '.java': {
        const javac = findExecutable(['javac'])
        const java = findExecutable(['java'])
        if (javac === undefined || java === undefined) return undefined
        const className = path.basename(file, '.java')
        const dir = path.dirname(file)
        return {
          command: `${javac} ${quote(file)} && ${java} -cp ${quote(dir)} ${className}`,
          matcher: '$dsh-gcc',
        }
      }
      case '.go': {
        const go = findExecutable(['go'])
        if (go === undefined) return undefined
        return { command: `go run ${quote(file)}` }
      }
      case '.rs': {
        const rustc = findExecutable(['rustc'])
        if (rustc === undefined) return undefined
        fs.mkdirSync(this.buildDir, { recursive: true })
        const exe = path.join(this.buildDir, `${path.basename(file, '.rs')}.exe`)
        return { command: `${rustc} ${quote(file)} -o ${quote(exe)} && ${quote(exe)}`, matcher: '$dsh-gcc' }
      }
      case '.html': {
        void vscode.env.openExternal(uriToFileUrl(file))
        return undefined
      }
      default:
        return undefined
    }
  }

  async runTask(taskName?: string): Promise<RunnerResult> {
    const folder = this.workspaceFolder
    if (folder === undefined) {
      void vscode.window.showWarningMessage('请先打开一个工作区文件夹再运行任务。')
      return { skipped: true }
    }
    const taskFile = path.join(folder.uri.fsPath, '.dsh-vscode', 'tasks.json')
    let tasks: { name: string; command: string; cwd?: string; matcher?: string }[] = []
    if (fs.existsSync(taskFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as { tasks?: unknown }
        if (Array.isArray(parsed.tasks)) {
          tasks = parsed.tasks.filter(
            (t): t is { name: string; command: string; cwd?: string; matcher?: string } =>
              typeof t === 'object' && t !== null &&
              typeof (t as { name?: unknown }).name === 'string' &&
              typeof (t as { command?: unknown }).command === 'string',
          )
        }
      } catch {
        void vscode.window.showErrorMessage(`无法解析 ${taskFile}（JSON 格式错误）。`)
        return { skipped: true }
      }
    } else {
      const create = '创建示例 .dsh-vscode/tasks.json'
      const pick = await vscode.window.showQuickPick([create], { placeHolder: '没有找到任务文件' })
      if (pick === create) {
        fs.mkdirSync(path.dirname(taskFile), { recursive: true })
        fs.writeFileSync(
          taskFile,
          JSON.stringify(
            {
              tasks: [
                { name: '示例: 运行 Python', command: 'python main.py', matcher: '$dsh-python' },
                { name: '示例: 编译并运行 C++', command: 'g++ main.cpp -o build/main.exe && build/main.exe', matcher: '$dsh-gcc' },
              ],
            },
            null,
            2,
          ),
          'utf8',
        )
        void vscode.window.showInformationMessage(`已创建 ${taskFile}，请按需修改后重试。`)
      }
      return { skipped: true }
    }
    if (tasks.length === 0) {
      void vscode.window.showWarningMessage('任务列表为空。')
      return { skipped: true }
    }
    let chosen: { name: string; command: string; cwd?: string; matcher?: string } | undefined
    if (taskName !== undefined) {
      chosen = tasks.find((t) => t.name === taskName)
      if (chosen === undefined) {
        void vscode.window.showWarningMessage(`找不到任务 "${taskName}"。`)
        return { skipped: true }
      }
    } else {
      chosen = (
        await vscode.window.showQuickPick(
          tasks.map((t) => ({ label: t.name, description: t.command, task: t })),
          { placeHolder: '选择要运行的任务' },
        )
      )?.task
    }
    if (chosen === undefined) return { skipped: true }
    const cwd = chosen.cwd !== undefined ? path.resolve(folder.uri.fsPath, chosen.cwd) : folder.uri.fsPath
    await this.execute(chosen.command, chosen.name, cwd, chosen.matcher)
    return { skipped: false }
  }

  private async execute(command: string, name: string, cwd: string, matcher?: string): Promise<void> {
    const execution = new vscode.ShellExecution(command, { cwd })
    const definition = { type: 'dsh-runner' }
    const task = new vscode.Task(
      definition,
      this.workspaceFolder ?? vscode.TaskScope.Workspace,
      name,
      'DSH Runner',
      execution,
      matcher !== undefined ? [matcher] : undefined,
    )
    await vscode.tasks.executeTask(task)
  }
}

function uriToFileUrl(file: string): vscode.Uri {
  return vscode.Uri.file(file)
}
