"use strict";
/**
 * The orchestrator tying runtime, store, and panel together. Owns the child
 * HarnessRuntime lifecycle, translates session-log events into transcript
 * mutations + panel deltas, and implements the user-facing actions
 * (send / stop / sessions / model / export / context).
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
exports.Controller = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const runtime_1 = require("./runtime");
const store_1 = require("./store");
const models_1 = require("./models");
class Controller {
    deps;
    store;
    runtime;
    settings;
    panel;
    pendingUsage = new Map();
    persistTimer;
    startPromise;
    currentModel;
    pendingContext;
    outputChannel;
    constructor(deps) {
        this.deps = deps;
        const config = vscode.workspace.getConfiguration('dshAgent');
        this.settings = {
            repoPath: config.get('repoPath') ?? '',
            configPath: config.get('configPath') ?? '',
            sessionRoot: config.get('sessionRoot') ?? '',
            extraEnv: config.get('env') ?? {},
            command: config.get('runtimeCommand') ?? 'node',
            extraArgs: config.get('runtimeArgs') ?? [],
            autoRestart: config.get('autoRestart') ?? true,
        };
        const models = (0, models_1.readModelOptions)();
        this.currentModel = models[0];
        const historyFile = path.join(this.deps.globalStoragePath, 'history.json');
        this.store = new store_1.SessionStore(historyFile);
    }
    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */
    attachPanel(panel) {
        this.panel = panel;
        this.pushState();
        if (this.pendingContext !== undefined && panel.isVisible()) {
            panel.post({ type: 'context', text: this.pendingContext });
            this.pendingContext = undefined;
        }
    }
    /** The webview finished loading and can now receive messages. */
    panelReady() {
        this.pushState();
        if (this.pendingContext !== undefined) {
            this.post({ type: 'context', text: this.pendingContext });
            this.pendingContext = undefined;
        }
    }
    detachPanel() {
        this.panel = undefined;
    }
    dispose() {
        if (this.persistTimer !== undefined)
            clearTimeout(this.persistTimer);
        this.store.persist();
        void this.runtime?.stop();
    }
    /** Start the child runtime on first use (modeled after lazy connect). */
    async ensureRuntime() {
        if (this.runtime !== undefined)
            return;
        const folder = this.deps.getWorkspaceFolder();
        const workspace = folder?.uri.fsPath ?? process.cwd();
        const repoPath = this.settings.repoPath !== '' ? this.settings.repoPath : (0, runtime_1.resolveRepoPath)(vscode.workspace.workspaceFolders);
        if (repoPath === '' || !fs.existsSync(path.join(repoPath, runtime_1.RUNTIME_MARKER))) {
            this.postError('未找到 deepseek-harness 运行时。请打开仓库作为工作区，或在设置 dshAgent.repoPath 中指定仓库路径。');
            return;
        }
        const sessionRoot = this.settings.sessionRoot !== '' ? this.settings.sessionRoot : path.join(this.deps.globalStoragePath, 'sessions');
        const configPath = (0, runtime_1.resolveRuntimeConfig)(path.join(this.deps.extensionUri.fsPath, 'media'), repoPath, this.settings.configPath);
        const runtime = new runtime_1.HarnessRuntime(repoPath, configPath, workspace, { provider: this.currentModel.provider, model: this.currentModel.model }, (0, models_1.readMaxTokens)(), this.settings, sessionRoot, {
            onEvent: (sessionId, event) => this.onEvent(sessionId, event),
            onStatus: (sessionId, status) => this.onStatus(sessionId, status),
            onSubagentStarted: (parent, child) => this.onSubagentStarted(parent, child),
            onSubagentFinished: (parent, child, status) => this.onSubagentFinished(parent, child, status),
            onExit: (code, unexpected, stderrTail) => this.onRuntimeExit(code, unexpected, stderrTail),
            onLog: (line) => this.log(line),
        });
        this.runtime = runtime;
        this.deps.setStatus('DSH Agent: 启动中…', '正在启动智能体运行时');
        this.post({ type: 'connected', connected: false, detail: '启动中…' });
        await runtime.start();
    }
    onRuntimeExit(code, unexpected, stderrTail) {
        if (!unexpected) {
            this.post({ type: 'connected', connected: false, detail: '已停止' });
            return;
        }
        this.store.closeAll();
        this.persistSoon();
        this.deps.setStatus('DSH Agent: 运行时已退出', `退出码 ${String(code)}\n${stderrTail.slice(-2000)}`);
        this.post({ type: 'connected', connected: false, detail: `运行时退出 (code=${String(code)})，正在自动重启…` });
    }
    async onStatus(sessionId, status) {
        const rec = this.store.get(sessionId);
        if (rec === undefined)
            return;
        rec.running = status === 'running';
        this.deps.setStatus(status === 'running' ? 'DSH Agent: 运行中…' : 'DSH Agent: 空闲', rec.title);
        if (sessionId === this.store.activeId) {
            this.post({ type: 'running', running: rec.running });
        }
    }
    log(line) {
        if (this.outputChannel === undefined) {
            this.outputChannel = vscode.window.createOutputChannel('DSH Agent Runtime', { log: true });
        }
        this.outputChannel.appendLine(line);
    }
    postError(message) {
        void vscode.window.showErrorMessage(`DSH Agent: ${message}`);
        this.post({ type: 'error', message });
    }
    /* ------------------------------------------------------------------ */
    /* Event translation                                                    */
    /* ------------------------------------------------------------------ */
    onEvent(sessionId, event) {
        const rec = this.store.get(sessionId);
        if (rec === undefined)
            return;
        switch (event.type) {
            case 'user/message':
                this.onUserMessage(rec, event);
                break;
            case 'assistant/chunk':
                this.onAssistantChunk(rec, event);
                break;
            case 'assistant/message':
                this.onAssistantMessage(rec, event);
                break;
            case 'tool/call':
                this.onToolCall(rec, event);
                break;
            case 'tool/result':
                this.onToolResult(rec, event);
                break;
            case 'turn/end':
                this.onTurnEnd(rec, event);
                break;
            case 'session/title':
                if (typeof event.data?.title === 'string') {
                    rec.title = event.data.title;
                    this.store.touch(rec);
                    this.persistSoon();
                    if (sessionId === this.store.activeId) {
                        this.post({ type: 'delta', kind: 'title', sessionId, title: rec.title });
                        this.pushSessionList();
                    }
                }
                break;
            case 'todo/write':
                if (Array.isArray(event.data?.todos)) {
                    rec.todos = event.data.todos;
                    if (sessionId === this.store.activeId) {
                        this.post({ type: 'delta', kind: 'todos', sessionId, todos: rec.todos });
                    }
                }
                break;
            default:
                break;
        }
    }
    onUserMessage(rec, event) {
        const data = event.data;
        // Only direct human prompts belong on the transcript; injected context
        // (AGENTS.md, skills, notices) is skipped so the panel stays a conversation.
        if (data.source !== undefined && data.source.kind !== 'user')
            return;
        const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        if (text === '')
            return;
        const last = rec.messages[rec.messages.length - 1];
        if (last !== undefined && last.role === 'user' && last.seq === undefined) {
            // echo of the prompt we just added locally
            last.seq = event.seq;
            last.id = data.id ?? last.id;
            return;
        }
        const msg = {
            id: data.id ?? `u-${event.seq}`,
            role: 'user',
            seq: event.seq,
            time: event.time,
            text,
        };
        rec.messages.push(msg);
        this.store.touch(rec);
        this.persistSoon();
        if (rec.id === this.store.activeId) {
            this.post({ type: 'delta', kind: 'user-msg', sessionId: rec.id, msg });
        }
    }
    stepKey(turn, step) {
        return `${turn}:${step}`;
    }
    findBubble(rec, key) {
        const existing = rec.messages.find((m) => m.role === 'assistant' && m.stepKey === key);
        if (existing !== undefined)
            return existing;
        const bubble = {
            id: key,
            stepKey: key,
            role: 'assistant',
            time: Date.now(),
            status: 'streaming',
            text: '',
            reasoning: '',
            toolCalls: [],
        };
        rec.messages.push(bubble);
        return bubble;
    }
    onAssistantChunk(rec, event) {
        const data = event.data;
        const key = this.stepKey(data.turn, data.step);
        const bubble = this.findBubble(rec, key);
        const chunk = data.chunk;
        switch (chunk.type) {
            case 'text-delta':
                bubble.text += chunk.text ?? '';
                break;
            case 'reasoning-delta':
                bubble.reasoning += chunk.text ?? '';
                break;
            case 'tool-call-delta': {
                const argsDelta = chunk.argumentsDelta ?? '';
                const id = chunk.id ?? `tc-${data.turn}-${data.step}`;
                let card = bubble.toolCalls?.find((c) => c.callId === id);
                if (card === undefined) {
                    card = { callId: id, name: chunk.name ?? 'tool', args: '', startTime: Date.now() };
                    bubble.toolCalls = [...(bubble.toolCalls ?? []), card];
                }
                else if (chunk.name !== undefined) {
                    card.name = chunk.name;
                }
                card.args += argsDelta;
                break;
            }
            case 'usage':
                this.pendingUsage.set(key, chunk);
                break;
            default:
                break;
        }
        if (rec.id === this.store.activeId) {
            this.post({
                type: 'delta',
                kind: 'assistant-delta',
                sessionId: rec.id,
                msgId: key,
                text: bubble.text,
                reasoning: bubble.reasoning,
            });
        }
    }
    onAssistantMessage(rec, event) {
        const data = event.data;
        const key = this.stepKey(data.turn, data.step);
        const bubble = this.findBubble(rec, key);
        let text = '';
        let reasoning = '';
        for (const block of data.message.content) {
            if (block.type === 'text')
                text += block.text ?? '';
            else if (block.type === 'reasoning')
                reasoning += block.text ?? '';
        }
        bubble.text = text;
        bubble.reasoning = reasoning;
        bubble.usage = normalizeUsage(data.usage ?? this.pendingUsage.get(key));
        bubble.status = 'done';
        bubble.time = event.time;
        this.pendingUsage.delete(key);
        this.store.touch(rec);
        this.persistSoon();
        if (rec.id === this.store.activeId) {
            this.post({
                type: 'delta',
                kind: 'assistant-commit',
                sessionId: rec.id,
                msgId: key,
                text,
                reasoning,
                usage: bubble.usage,
                toolCalls: bubble.toolCalls ?? [],
            });
        }
    }
    onToolCall(rec, event) {
        const data = event.data;
        const key = this.stepKey(data.turn, data.step);
        const bubble = this.findBubble(rec, key);
        const card = { callId: data.callId, name: data.name, args: data.arguments, startTime: event.time };
        const existing = bubble.toolCalls?.find((c) => c.callId === data.callId);
        if (existing !== undefined) {
            existing.name = data.name;
            existing.args = data.arguments;
        }
        else {
            bubble.toolCalls = [...(bubble.toolCalls ?? []), card];
        }
        if (rec.id === this.store.activeId) {
            this.post({ type: 'delta', kind: 'tool-start', sessionId: rec.id, msgId: key, card: existing ?? card });
        }
    }
    onToolResult(rec, event) {
        const data = event.data;
        const callId = data.message?.source?.callId ?? data.message?.content?.[0]?.toolCallId;
        if (callId === undefined)
            return;
        let bubble;
        for (const m of rec.messages) {
            if (m.role === 'assistant' && m.toolCalls?.some((c) => c.callId === callId)) {
                bubble = m;
                break;
            }
        }
        if (bubble === undefined)
            return;
        const card = bubble.toolCalls?.find((c) => c.callId === callId);
        if (card === undefined)
            return;
        const block = data.message?.content?.[0];
        const resultText = (block?.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
        card.resultText = resultText;
        card.isError = block?.isError === true || data.error !== undefined;
        card.endTime = event.time;
        this.store.touch(rec);
        this.persistSoon();
        if (rec.id === this.store.activeId) {
            this.post({ type: 'delta', kind: 'tool-end', sessionId: rec.id, msgId: bubble.id, card });
        }
    }
    onTurnEnd(rec, event) {
        const data = event.data;
        const reason = data.reason;
        let status = 'done';
        let error;
        switch (reason?.kind) {
            case 'completed':
            case 'blocked':
                status = 'done';
                break;
            case 'aborted':
            case 'interrupted':
                status = 'cancelled';
                break;
            case 'max-tokens':
                status = 'max-tokens';
                break;
            case 'error':
                status = 'error';
                error = reason.error?.message ?? '模型请求失败';
                break;
            default:
                status = 'done';
        }
        for (const m of rec.messages) {
            if (m.role === 'assistant' && m.status === 'streaming') {
                m.status = status;
                if (error !== undefined)
                    m.error = error;
            }
        }
        rec.running = false;
        this.store.touch(rec);
        this.persistSoon();
        if (rec.id === this.store.activeId) {
            this.post({ type: 'delta', kind: 'turn-end', sessionId: rec.id, status, error });
            this.post({ type: 'running', running: false });
        }
    }
    onSubagentStarted(parent, child) {
        const rec = this.store.get(parent);
        if (rec === undefined)
            return;
        rec.messages.push({
            id: `sub-${child}`,
            role: 'notice',
            time: Date.now(),
            text: `🔄 子代理已启动 (${child.slice(0, 8)}…)`,
            noticeKind: 'subagent-start',
        });
        this.store.touch(rec);
        this.persistSoon();
        if (parent === this.store.activeId) {
            this.post({ type: 'delta', kind: 'notice', sessionId: parent, text: rec.messages[rec.messages.length - 1].text ?? '' });
        }
    }
    onSubagentFinished(parent, child, status) {
        const rec = this.store.get(parent);
        if (rec === undefined)
            return;
        rec.messages.push({
            id: `subend-${child}`,
            role: 'notice',
            time: Date.now(),
            text: `${status === 'ok' ? '✅' : '❌'} 子代理完成 (${child.slice(0, 8)}…)`,
            noticeKind: 'subagent-end',
        });
        this.store.touch(rec);
        this.persistSoon();
        if (parent === this.store.activeId) {
            this.post({ type: 'delta', kind: 'notice', sessionId: parent, text: rec.messages[rec.messages.length - 1].text ?? '' });
        }
    }
    /* ------------------------------------------------------------------ */
    /* User actions                                                         */
    /* ------------------------------------------------------------------ */
    async send(text) {
        const trimmed = text.trim();
        if (trimmed === '')
            return;
        try {
            await this.ensureRuntime();
        }
        catch (err) {
            this.postError(`启动运行时失败: ${String(err)}`);
            return;
        }
        const runtime = this.runtime;
        if (runtime === undefined || !runtime.ready) {
            this.postError('运行时尚未就绪，请稍后重试。');
            return;
        }
        let rec = this.store.activeId !== undefined ? this.store.get(this.store.activeId) : undefined;
        if (rec === undefined || rec.closed) {
            rec = this.store.createSession(this.currentModel.model);
        }
        const sessionId = rec.id;
        rec.messages.push({
            id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            time: Date.now(),
            text: trimmed,
        });
        rec.running = true;
        this.store.touch(rec);
        this.persistSoon();
        this.post({ type: 'delta', kind: 'user-msg', sessionId, msg: rec.messages[rec.messages.length - 1] });
        this.post({ type: 'running', running: true });
        this.pushSessionList();
        try {
            await runtime.sendPrompt(sessionId, trimmed);
        }
        catch (err) {
            this.postError(`发送失败: ${String(err)}`);
            rec.running = false;
            this.post({ type: 'running', running: false });
        }
    }
    async stop() {
        if (this.runtime === undefined)
            return;
        this.store.closeAll();
        this.persistSoon();
        await this.runtime.stop();
        this.runtime = undefined; // next send starts a fresh runtime + session
        this.post({ type: 'connected', connected: false, detail: '已停止' });
        this.post({ type: 'delta', kind: 'notice', sessionId: this.store.activeId ?? '', text: '⏹ 已停止当前任务（运行时已关闭，会话已归档）。' });
        this.deps.setStatus('DSH Agent: 已停止', '点击可重新打开面板');
    }
    async restartRuntime() {
        if (this.runtime === undefined)
            return;
        this.store.closeAll();
        this.persistSoon();
        await this.runtime.stop();
        this.runtime = undefined;
        this.post({ type: 'delta', kind: 'notice', sessionId: this.store.activeId ?? '', text: '运行时已重启。' });
        try {
            await this.ensureRuntime();
        }
        catch (err) {
            this.postError(`重启失败: ${String(err)}`);
        }
    }
    async pickModel() {
        const models = (0, models_1.readModelOptions)();
        const pick = await vscode.window.showQuickPick(models.map((m) => ({ label: m.label, description: `${m.provider} / ${m.model}`, option: m })), { placeHolder: '选择模型（切换会重启运行时）' });
        return pick?.option;
    }
    async onSettingsChanged() {
        const models = (0, models_1.readModelOptions)();
        if (models.length === 0)
            return;
        const stillExists = models.some((m) => m.provider === this.currentModel.provider && m.model === this.currentModel.model);
        if (!stillExists)
            this.currentModel = models[0];
        this.pushState();
        if (this.runtime !== undefined && this.runtime.ready) {
            this.post({
                type: 'delta',
                kind: 'notice',
                sessionId: this.store.activeId ?? '',
                text: '检测到设置变更，正在重启运行时以生效…',
            });
            await this.restartRuntime();
        }
    }
    async newSession() {
        const rec = this.store.createSession(this.currentModel.model);
        this.persistSoon();
        this.pushState();
        void this.panel?.post({ type: 'focus-input' });
    }
    switchSession(id) {
        const rec = this.store.get(id);
        if (rec === undefined)
            return;
        this.store.activeId = id;
        this.deps.setStatus(rec.running ? 'DSH Agent: 运行中…' : 'DSH Agent: 空闲', rec.title);
        this.post({ type: 'switch-session', session: this.serializeSession(rec) });
        this.pushSessionList();
    }
    deleteSession(id) {
        this.store.delete(id);
        this.persistSoon();
        this.pushState();
    }
    async changeModel(option) {
        if (this.currentModel.provider === option.provider &&
            this.currentModel.model === option.model) {
            return;
        }
        this.currentModel = option;
        const hadRuntime = this.runtime !== undefined;
        if (hadRuntime) {
            this.store.closeAll();
            this.persistSoon();
            await this.runtime?.stop();
            this.runtime = undefined;
        }
        this.post({ type: 'model', model: option });
        this.post({
            type: 'delta',
            kind: 'notice',
            sessionId: this.store.activeId ?? '',
            text: `模型已切换为 ${option.label}。`,
        });
        if (hadRuntime) {
            void this.ensureRuntime().catch((err) => this.postError(`重启失败: ${String(err)}`));
        }
    }
    async exportActiveSession() {
        const rec = this.store.activeId !== undefined ? this.store.get(this.store.activeId) : undefined;
        if (rec === undefined)
            return;
        const defaultName = `${rec.title.replace(/[\\/:*?"<>|]/g, '_') || 'session'}.md`;
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(this.deps.getWorkspaceFolder()?.uri.fsPath ?? process.cwd(), defaultName)),
            filters: { Markdown: ['md'] },
        });
        if (target === undefined)
            return;
        const md = this.toMarkdown(rec);
        try {
            fs.writeFileSync(target.fsPath, md, 'utf8');
            void vscode.window.showInformationMessage(`已导出到 ${target.fsPath}`);
        }
        catch (err) {
            this.postError(`导出失败: ${String(err)}`);
        }
    }
    toMarkdown(rec) {
        const lines = [
            `# ${rec.title}`,
            '',
            `- 模型: ${rec.model}`,
            `- 创建: ${new Date(rec.createdAt).toLocaleString()}`,
            `- 状态: ${rec.closed ? '已归档（运行时已关闭）' : '活动'}`,
            '',
            '---',
            '',
        ];
        for (const m of rec.messages) {
            if (m.role === 'user') {
                lines.push('## 🧑 用户', '', m.text ?? '', '');
            }
            else if (m.role === 'assistant') {
                lines.push('## 🤖 助手', '', m.text ?? '', '');
                if ((m.reasoning ?? '') !== '') {
                    lines.push('<details><summary>💭 思考过程</summary>', '', m.reasoning ?? '', '', '</details>', '');
                }
                for (const card of m.toolCalls ?? []) {
                    lines.push(`### 🛠 ${card.name}`, '', '```json', card.args, '```', '');
                    if (card.resultText !== undefined) {
                        lines.push('结果：', '', '```', card.resultText.slice(0, 4000), '```', '');
                    }
                }
            }
            else if (m.role === 'notice') {
                lines.push(`> ${m.text ?? ''}`, '');
            }
        }
        return lines.join('\n');
    }
    /* ------------------------------------------------------------------ */
    /* Panel state + history                                                */
    /* ------------------------------------------------------------------ */
    showHistory() {
        const sessions = this.store.list();
        if (sessions.length === 0) {
            void vscode.window.showInformationMessage('暂无会话历史。');
            return;
        }
        void vscode.window.showQuickPick(sessions.map((s) => ({
            label: s.title || '（无标题）',
            description: `${s.closed ? '已归档' : '活动'} · ${s.model} · ${new Date(s.updatedAt).toLocaleString()}`,
            id: s.id,
        })), { placeHolder: '选择要打开的会话' }).then((pick) => {
            if (pick !== undefined)
                this.switchSession(pick.id);
        });
    }
    clearHistory() {
        for (const id of [...this.store.sessions.keys()])
            this.store.delete(id);
        this.persistSoon();
        this.pushState();
    }
    serializeSession(rec) {
        return {
            id: rec.id,
            title: rec.title,
            model: rec.model,
            running: rec.running,
            closed: rec.closed,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            todos: rec.todos,
            messages: rec.messages,
        };
    }
    pushState() {
        const active = this.store.activeId !== undefined ? this.store.get(this.store.activeId) : undefined;
        this.post({
            type: 'state',
            models: (0, models_1.readModelOptions)(),
            currentModel: this.currentModel,
            sessions: this.store.list().map((s) => ({
                id: s.id,
                title: s.title,
                model: s.model,
                running: s.running,
                closed: s.closed,
                updatedAt: s.updatedAt,
            })),
            activeId: this.store.activeId ?? null,
            transcript: active !== undefined ? this.serializeSession(active) : null,
            connected: this.runtime?.ready === true,
            detail: this.runtime === undefined ? '未连接' : this.runtime.ready ? '已连接' : '启动中…',
        });
    }
    pushSessionList() {
        this.post({
            type: 'session-list',
            sessions: this.store.list().map((s) => ({
                id: s.id,
                title: s.title,
                model: s.model,
                running: s.running,
                closed: s.closed,
                updatedAt: s.updatedAt,
            })),
            activeId: this.store.activeId ?? null,
        });
    }
    post(msg) {
        if (this.panel !== undefined)
            this.panel.post(msg);
    }
    persistSoon() {
        if (this.persistTimer !== undefined)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            this.store.persist();
        }, 1500);
    }
    /* ------------------------------------------------------------------ */
    /* Context (selection / file / terminal)                                */
    /* ------------------------------------------------------------------ */
    async contextSelection() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined)
            return;
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (text === '') {
            void vscode.window.showInformationMessage('当前没有选中内容。');
            return;
        }
        const lang = editor.document.languageId;
        this.queueContext(`请分析下面选中的代码（${editor.document.uri.fsPath}）：\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
        void this.focusPanel();
    }
    async contextFile() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined)
            return;
        const uri = editor.document.uri;
        const full = editor.document.getText();
        const max = 200_000;
        const body = full.length > max ? `${full.slice(0, max)}\n…（文件过长，已截断）` : full;
        this.queueContext(`这是文件 ${uri.fsPath} 的完整内容：\n\`\`\`${editor.document.languageId}\n${body}\n\`\`\`\n`);
        void this.focusPanel();
    }
    /** Deliver context text to the input box; queue it when the panel is closed. */
    queueContext(text) {
        if (this.panel !== undefined && this.panel.isVisible()) {
            this.post({ type: 'context', text });
            this.pendingContext = undefined;
        }
        else {
            this.pendingContext = text;
        }
    }
    async focusPanel() {
        await vscode.commands.executeCommand('dshAgent.focus');
        await vscode.commands.executeCommand('workbench.view.extension.dshAgent');
    }
}
exports.Controller = Controller;
function normalizeUsage(usage) {
    if (usage === undefined)
        return undefined;
    return {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        reasoning: usage.reasoningTokens,
    };
}
//# sourceMappingURL=controller.js.map