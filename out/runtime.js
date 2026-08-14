"use strict";
/**
 * Manages the child DeepSeek Harness runtime process: resolve where it lives,
 * write the runtime composition, spawn `dsh-jsonrpc-agent`, run the SDK
 * `initialize` handshake, stream notifications, and restart after crashes.
 *
 * The child owns real credentials and full workspace access; it is spawned
 * from the user's machine exactly like the harness desktop app would run it.
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
exports.HarnessRuntime = exports.RUNTIME_MARKER = void 0;
exports.resolveRepoPath = resolveRepoPath;
exports.buildLaunchPlan = buildLaunchPlan;
exports.resolveRuntimeConfig = resolveRuntimeConfig;
const childProcess = __importStar(require("node:child_process"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const protocol_1 = require("./protocol");
exports.RUNTIME_MARKER = 'packages/examples/jsonrpc-demo';
/** Locate the harness checkout: explicit setting, env, then workspace probe. */
function resolveRepoPath(workspaceFolders) {
    const fromSetting = vscode.workspace.getConfiguration('dshAgent').get('repoPath') ?? '';
    if (fromSetting.trim() !== '')
        return fromSetting.trim();
    const fromEnv = process.env.DSH_REPO_PATH;
    if (fromEnv !== undefined && fromEnv.trim() !== '')
        return fromEnv.trim();
    for (const folder of workspaceFolders ?? []) {
        const candidate = folder.uri.fsPath;
        if (fs.existsSync(path.join(candidate, exports.RUNTIME_MARKER, 'lib', 'bin.js')))
            return candidate;
        if (fs.existsSync(path.join(candidate, exports.RUNTIME_MARKER, 'src', 'bin.ts')))
            return candidate;
    }
    return '';
}
function buildLaunchPlan(settings, repoPath, configPath, workspace, persona, model, maxTokens, sessionRoot) {
    const builtBin = path.join(repoPath, exports.RUNTIME_MARKER, 'lib', 'bin.js');
    const srcBin = path.join(repoPath, exports.RUNTIME_MARKER, 'src', 'bin.ts');
    let args;
    if (fs.existsSync(builtBin)) {
        args = [builtBin, configPath];
    }
    else if (fs.existsSync(srcBin)) {
        args = ['--import', 'tsx/esm', srcBin, configPath];
    }
    else {
        return {
            command: settings.command,
            args: [],
            cwd: repoPath,
            env: {},
            error: `未找到 jsonrpc 运行时入口（${exports.RUNTIME_MARKER}/lib/bin.js 或 src/bin.ts）。` +
                '请检查 dshAgent.repoPath 设置，或先构建仓库（pnpm run build）。',
        };
    }
    const env = {
        ...process.env,
        DSH_CWD: workspace,
        DSH_SYSTEM_PROMPT: persona,
        DSH_SESSION_ROOT: sessionRoot,
        ...settings.extraEnv,
    };
    return { command: settings.command, args: [...args, ...settings.extraArgs], cwd: repoPath, env };
}
/** Write the built-in composition into the repo's examples resolution tree so bare plugins resolve, or honor a custom path. */
function resolveRuntimeConfig(mediaDir, repoPath, customPath) {
    if (customPath.trim() !== '') {
        if (!fs.existsSync(customPath)) {
            throw new Error(`dshAgent.configPath 不存在: ${customPath}`);
        }
        return customPath;
    }
    // The config lives inside examples/jsonrpc-agent so Node's ancestor walk
    // reaches examples/node_modules, where the dsh-examples workspace links the
    // bare plugin packages named by the composition.
    const target = path.join(repoPath, 'examples', 'jsonrpc-agent', 'vscode-agent.cordis.yml');
    const src = path.join(mediaDir, 'cordis.yml');
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const bundled = fs.readFileSync(src, 'utf8');
        const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        if (existing !== bundled)
            fs.writeFileSync(target, bundled, 'utf8');
    }
    catch (err) {
        throw new Error(`写入运行时配置失败: ${String(err)}`);
    }
    return target;
}
class HarnessRuntime {
    repoPath;
    configPath;
    workspace;
    model;
    maxTokens;
    settings;
    sessionRoot;
    cb;
    child;
    client;
    stderrTail = '';
    userStopped = false;
    restartTimer;
    restartAttempts = 0;
    ready = false;
    cwd;
    constructor(repoPath, configPath, workspace, model, maxTokens, settings, sessionRoot, cb) {
        this.repoPath = repoPath;
        this.configPath = configPath;
        this.workspace = workspace;
        this.model = model;
        this.maxTokens = maxTokens;
        this.settings = settings;
        this.sessionRoot = sessionRoot;
        this.cb = cb;
        this.cwd = workspace;
    }
    personaText() {
        return vscode.workspace.getConfiguration('dshAgent').get('systemPrompt') ?? '';
    }
    get running() {
        return this.child !== undefined && this.ready;
    }
    log(line) {
        this.cb.onLog(line);
    }
    async start() {
        if (this.ready)
            return;
        this.userStopped = false;
        this.restartAttempts = 0;
        await this.spawnOnce();
    }
    async spawnOnce() {
        const plan = buildLaunchPlan(this.settings, this.repoPath, this.configPath, this.workspace, this.personaText(), this.model, this.maxTokens, this.sessionRoot);
        if (plan.error !== undefined) {
            throw new Error(plan.error);
        }
        this.log(`启动运行时: ${plan.command} ${plan.args.join(' ')}`);
        this.stderrTail = '';
        const child = childProcess.spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            env: plan.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        const tail = [];
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            tail.push(chunk);
            if (tail.join('').length > 32768)
                tail.shift();
            this.stderrTail = tail.join('');
            const lines = chunk.split(/\r?\n/).filter(Boolean);
            for (const line of lines.slice(-5))
                this.log(`[runtime] ${line}`);
        });
        if (child.stdin === null || child.stdout === null) {
            child.kill();
            throw new Error('运行时 stdio 不可用');
        }
        const client = new protocol_1.LineJsonRpcClient(child.stdout, child.stdin, (method, params) => {
            this.dispatchNotification(method, params);
        });
        this.client = client;
        const exitHandler = (code) => {
            client.dispose();
            this.ready = false;
            const unexpected = !this.userStopped;
            this.cb.onExit(code, unexpected, this.stderrTail);
            if (unexpected && this.settings.autoRestart && this.restartAttempts < 5) {
                const delay = Math.min(1000 * 2 ** this.restartAttempts, 15000);
                this.restartAttempts += 1;
                this.log(`运行时退出（code=${String(code)}），${delay}ms 后自动重启…`);
                this.restartTimer = setTimeout(() => {
                    void this.spawnOnce().catch((err) => this.log(`自动重启失败: ${String(err)}`));
                }, delay);
            }
        };
        child.once('exit', exitHandler);
        child.once('error', (err) => {
            this.log(`运行时进程错误: ${String(err)}`);
            this.cb.onExit(-1, true, `${this.stderrTail}\n${String(err)}`);
        });
        const timeoutMs = 90000;
        const result = await withTimeout(client.request('initialize', {
            cwd: this.workspace,
            provider: this.model.provider,
            model: this.model.model,
            ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        }), timeoutMs, '运行时初始化超时（90s）——请检查 DSH_HOME 凭据、API 网络或 stderr 输出');
        this.ready = true;
        this.log(`运行时就绪: ${result.serverInfo.name}@${result.serverInfo.version}（${this.model.model}）`);
    }
    dispatchNotification(method, params) {
        try {
            switch (method) {
                case 'session.event': {
                    const p = params;
                    this.cb.onEvent(p.sessionId, p.event);
                    break;
                }
                case 'session.status': {
                    const p = params;
                    this.cb.onStatus(p.sessionId, p.status);
                    break;
                }
                case 'subagent.started': {
                    const p = params;
                    this.cb.onSubagentStarted(p.parentSessionId, p.childSessionId);
                    break;
                }
                case 'subagent.finished': {
                    const p = params;
                    this.cb.onSubagentFinished(p.parentSessionId, p.childSessionId, p.status);
                    break;
                }
                default:
                    break;
            }
        }
        catch (err) {
            this.log(`处理通知 ${method} 失败: ${String(err)}`);
        }
    }
    async sendPrompt(sessionId, text) {
        if (!this.ready || this.child === undefined || this.client === undefined) {
            throw new Error('运行时未就绪');
        }
        const result = await this.client.request('session/prompt', {
            sessionId,
            contentBlocks: [{ type: 'text', text }],
        });
        return result.messageId;
    }
    /** Stop the child (protocol `shutdown`, then kill ladder). User-initiated. */
    async stop() {
        this.userStopped = true;
        if (this.restartTimer !== undefined) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        const child = this.child;
        const client = this.client;
        this.ready = false;
        this.child = undefined;
        this.client = undefined;
        if (child === undefined || child.exitCode !== null)
            return;
        try {
            if (client !== undefined) {
                await withTimeout(client.request('shutdown'), 3000, 'shutdown 超时');
            }
        }
        catch {
            // fall through to kill
        }
        if (child.exitCode === null) {
            if (child.stdin !== null)
                child.stdin.end();
            await waitExit(child, 2500);
        }
        if (child.exitCode === null)
            child.kill();
    }
    /** Hard-kill without protocol shutdown (crash-cleanup path). */
    kill() {
        if (this.restartTimer !== undefined) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        this.userStopped = true;
        this.ready = false;
        const child = this.child;
        this.child = undefined;
        this.client?.dispose();
        this.client = undefined;
        if (child !== undefined && child.exitCode === null)
            child.kill();
    }
    dispose() {
        this.kill();
    }
}
exports.HarnessRuntime = HarnessRuntime;
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}
function waitExit(child, ms) {
    return new Promise((resolve) => {
        if (child.exitCode !== null)
            return resolve();
        const timer = setTimeout(resolve, ms);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}
//# sourceMappingURL=runtime.js.map