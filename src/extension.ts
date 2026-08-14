/**
 * DSH Agent — DeepSeek Harness inside VS Code.
 * Activation wires the side-bar panel, the child-runtime controller, commands,
 * status bar, and the no-config runner.
 */

import * as vscode from 'vscode'
import { Controller } from './controller'
import { ChatPanelProvider } from './panel'
import { Runner } from './runner'

let controller: Controller | undefined

export function activate(context: vscode.ExtensionContext): void {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusItem.text = '$(sparkle) DSH Agent'
  statusItem.command = 'dshAgent.focus'
  statusItem.tooltip = 'DSH Agent：打开 Agent 面板'
  statusItem.show()
  context.subscriptions.push(statusItem)

  controller = new Controller({
    extensionUri: context.extensionUri,
    globalStoragePath: context.globalStorageUri.fsPath,
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0],
    createPanelSink: () => undefined,
    setStatus: (text: string, tooltip?: string) => {
      statusItem.text = '$(sparkle) DSH Agent'
      statusItem.tooltip = tooltip ?? text
    },
  })

  const provider = new ChatPanelProvider(context.extensionUri, controller)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dshAgent.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  const runner = new Runner(vscode.workspace.workspaceFolders?.[0])

  const register = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }

  register('dshAgent.focus', () => {
    void vscode.commands.executeCommand('workbench.view.extension.dshAgent')
  })

  register('dshAgent.newSession', () => controller?.newSession())
  register('dshAgent.stop', () => controller?.stop())
  register('dshAgent.restartRuntime', async () => {
    if (controller === undefined) return
    await controller.restartRuntime()
  })
  register('dshAgent.changeModel', async () => {
    if (controller === undefined) return
    const option = await controller.pickModel()
    if (option !== undefined) await controller.changeModel(option)
  })
  register('dshAgent.askSelection', () => controller?.contextSelection())
  register('dshAgent.addFileToContext', () => controller?.contextFile())
  register('dshAgent.exportConversation', () => controller?.exportActiveSession())
  register('dshAgent.history', () => controller?.showHistory())
  register('dshAgent.openSettings', () => {
    void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dsh-agent-vscode')
  })

  register('dshAgent.runFile', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri
    if (target === undefined) {
      void vscode.window.showWarningMessage('没有可运行的文件。')
      return
    }
    await runner.runFile(target)
  })

  register('dshAgent.runTask', () => runner.runTask())

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dshAgent')) return
      if (
        e.affectsConfiguration('dshAgent.models') ||
        e.affectsConfiguration('dshAgent.systemPrompt') ||
        e.affectsConfiguration('dshAgent.maxTokens') ||
        e.affectsConfiguration('dshAgent.env') ||
        e.affectsConfiguration('dshAgent.repoPath') ||
        e.affectsConfiguration('dshAgent.configPath')
      ) {
        void controller?.onSettingsChanged()
      }
    }),
  )

  context.subscriptions.push({ dispose: () => controller?.dispose() })
}

export function deactivate(): void {
  controller?.dispose()
  controller = undefined
}
