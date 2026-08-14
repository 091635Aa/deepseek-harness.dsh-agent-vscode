"use strict";
/**
 * Side-bar webview panel (the agent IDE surface). Bridges the controller to a
 * zero-dependency vanilla-JS client in media/main.js. All user actions arrive
 * here as messages and are forwarded to the controller.
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
exports.ChatPanelProvider = void 0;
const vscode = __importStar(require("vscode"));
function getNonce() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
class ChatPanelProvider {
    extensionUri;
    controller;
    view;
    constructor(extensionUri, controller) {
        this.extensionUri = extensionUri;
        this.controller = controller;
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((msg) => {
            void this.onMessage(msg);
        });
        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.controller.detachPanel();
        });
        this.controller.attachPanel(this);
    }
    post(msg) {
        if (this.view !== undefined)
            void this.view.webview.postMessage(msg);
    }
    isVisible() {
        return this.view?.visible ?? false;
    }
    async onMessage(msg) {
        switch (msg.type) {
            case 'ready':
                this.controller.panelReady();
                break;
            case 'send':
                if (typeof msg.text === 'string')
                    void this.controller.send(msg.text);
                break;
            case 'stop':
                void this.controller.stop();
                break;
            case 'restart-runtime':
                void this.controller.restartRuntime();
                break;
            case 'new-session':
                void this.controller.newSession();
                break;
            case 'switch-session':
                if (typeof msg.id === 'string')
                    this.controller.switchSession(msg.id);
                break;
            case 'delete-session':
                if (typeof msg.id === 'string')
                    this.controller.deleteSession(msg.id);
                break;
            case 'change-model':
                if (typeof msg.label === 'string' &&
                    typeof msg.provider === 'string' &&
                    typeof msg.model === 'string') {
                    void this.controller.changeModel({ label: msg.label, provider: msg.provider, model: msg.model });
                }
                break;
            case 'export':
                void this.controller.exportActiveSession();
                break;
            case 'clear-history':
                this.controller.clearHistory();
                break;
            case 'context':
                if (msg.kind === 'selection')
                    void this.controller.contextSelection();
                else if (msg.kind === 'file')
                    void this.controller.contextFile();
                break;
            default:
                break;
        }
    }
    renderHtml(webview) {
        const nonce = getNonce();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>DSH Agent</title>
</head>
<body>
  <header id="app-header">
    <div class="session-tabs" id="session-tabs"></div>
    <div class="header-actions">
      <select id="model-select" title="切换模型（会重启运行时）"></select>
      <button id="btn-new" class="icon-btn" title="新建会话">＋</button>
      <button id="btn-stop" class="icon-btn danger" title="停止当前任务 (Ctrl+Alt+X)">⏹</button>
      <button id="btn-export" class="icon-btn" title="导出为 Markdown">⬇</button>
      <button id="btn-restart" class="icon-btn" title="重启运行时">↻</button>
    </div>
    <div class="conn-row">
      <span id="conn-dot" class="dot"></span>
      <span id="conn-text">未连接</span>
      <span class="spacer"></span>
      <span id="model-badge"></span>
    </div>
  </header>
  <main id="transcript"></main>
  <section id="todos-wrap" hidden>
    <div class="todos-head">任务清单 <button id="btn-todos-toggle" class="mini-btn">收起</button></div>
    <ul id="todos"></ul>
  </section>
  <footer id="composer">
    <div class="composer-toolbar">
      <button id="ctx-selection" class="mini-btn" title="把当前选中的代码加入下文">＋选中代码</button>
      <button id="ctx-file" class="mini-btn" title="把当前文件加入下文">＋当前文件</button>
      <span class="spacer"></span>
      <span class="hint">Enter 发送 · Shift+Enter 换行</span>
    </div>
    <textarea id="input" rows="3" placeholder="给 DSH 智能体发消息…"></textarea>
    <div class="composer-actions">
      <button id="btn-send" class="send-btn" disabled>发送</button>
    </div>
  </footer>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
exports.ChatPanelProvider = ChatPanelProvider;
//# sourceMappingURL=panel.js.map