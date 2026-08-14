"use strict";
/**
 * DSH Agent — DeepSeek Harness inside VS Code.
 * Activation wires the side-bar panel, the child-runtime controller, commands,
 * status bar, and the no-config runner.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const controller_1 = require("./controller");
const panel_1 = require("./panel");
const runner_1 = require("./runner");
let controller;
function activate(context) {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.text = '$(sparkle) DSH Agent';
    statusItem.command = 'dshAgent.focus';
    statusItem.tooltip = 'DSH Agent：打开 Agent 面板';
    statusItem.show();
    context.subscriptions.push(statusItem);
    controller = new controller_1.Controller({
        extensionUri: context.extensionUri,
        globalStoragePath: context.globalStorageUri.fsPath,
        getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0],
        createPanelSink: () => undefined,
        setStatus: (text, tooltip) => {
            statusItem.text = '$(sparkle) DSH Agent';
            statusItem.tooltip = tooltip ?? text;
        },
    });
    const provider = new panel_1.ChatPanelProvider(context.extensionUri, controller);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('dshAgent.chatView', provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    const runner = new runner_1.Runner(vscode.workspace.workspaceFolders?.[0]);
    const register = (id, fn) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    };
    register('dshAgent.focus', () => {
        void vscode.commands.executeCommand('workbench.view.extension.dshAgent');
    });
    register('dshAgent.newSession', () => controller?.newSession());
    register('dshAgent.stop', () => controller?.stop());
    register('dshAgent.restartRuntime', async () => {
        if (controller === undefined)
            return;
        await controller.restartRuntime();
    });
    register('dshAgent.changeModel', async () => {
        if (controller === undefined)
            return;
        const option = await controller.pickModel();
        if (option !== undefined)
            await controller.changeModel(option);
    });
    register('dshAgent.askSelection', () => controller?.contextSelection());
    register('dshAgent.addFileToContext', () => controller?.contextFile());
    register('dshAgent.exportConversation', () => controller?.exportActiveSession());
    register('dshAgent.history', () => controller?.showHistory());
    register('dshAgent.openSettings', () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dsh-agent-vscode');
    });
    register('dshAgent.runFile', async (uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (target === undefined) {
            void vscode.window.showWarningMessage('没有可运行的文件。');
            return;
        }
        await runner.runFile(target);
    });
    register('dshAgent.runTask', () => runner.runTask());
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('dshAgent'))
            return;
        if (e.affectsConfiguration('dshAgent.models') ||
            e.affectsConfiguration('dshAgent.systemPrompt') ||
            e.affectsConfiguration('dshAgent.maxTokens') ||
            e.affectsConfiguration('dshAgent.env') ||
            e.affectsConfiguration('dshAgent.repoPath') ||
            e.affectsConfiguration('dshAgent.configPath')) {
            void controller?.onSettingsChanged();
        }
    }));
    context.subscriptions.push({ dispose: () => controller?.dispose() });
}
function deactivate() {
    controller?.dispose();
    controller = undefined;
}
//# sourceMappingURL=extension.js.map