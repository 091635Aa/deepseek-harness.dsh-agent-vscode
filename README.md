# DSH Agent for VS Code

把 **DeepSeek Harness** 智能体完整搬进 VS Code 的原生 Agent IDE 扩展：侧边栏智能体面板、流式对话、模型切换、子代理、联网搜索、会话历史与导出，以及**免 launch.json 的一键运行/编译**。后端就是 DeepSeek Harness 自己 —— 扩展把一个完整的 Harness 运行时作为子进程拉起来，通过 [SDK JSON-RPC](../../packages/sdk/README.md) 协议驱动，因此你的 agent 工具、bash、文件读写、技能（skills）和网络搜索能力与桌面版完全一致。

> 本扩展由 DeepSeek Harness 智能体自主编写（见仓库根目录 `插件/`）。

## 功能一览

| 类别 | 能力 |
|---|---|
| 对话面板 | 侧边栏聊天面板（`Ctrl+Alt+D` 聚焦）、**流式输出**（text/reasoning 增量实时渲染）、思考过程折叠、Markdown 渲染、token 用量显示 |
| 模型 | 面板内模型下拉切换（DeepSeek V4 Flash / Pro，可自定义 provider+model 列表）、按会话记录模型 |
| 会话 | 多会话标签页、`session/title` 自动标题、会话历史（本地持久化）、历史快速打开、导出 Markdown、删除会话 |
| Agent 工具 | bash、文件读写（read-before-edit 策略）、子代理、todo_write 任务清单（面板内实时展示）、技能（skills）、工作区 AGENTS.md 上下文、**web_search / web_fetch 联网搜索**、token 计量与自动压缩 |
| 运行 | **免 launch.json**：直接运行当前文件（Python/JS/TS/Shell/PowerShell/C/C++/Java/Go/Rust），编译产物自动进 **Problems 面板**（GCC/TS/Java/Python 问题匹配器）；`.dsh-vscode/tasks.json` 自定义任务 |
| IDE 集成 | 右键选中代码「询问选中代码」、右键「将当前文件加入上下文」、状态栏状态、停止当前任务（`Ctrl+Alt+X`）、重启运行时 |

## 环境要求

- VS Code ≥ 1.90
- Node.js ≥ 22.19（推荐 24+，zstd 会话压缩需要 `node:zlib` 的 zstd 支持）
- DeepSeek Harness 仓库（本扩展默认从**当前工作区**自动探测；也可用 `dshAgent.repoPath` 指定）
- 模型凭据：自动复用 `$DSH_HOME/.credentials.yaml`（DeepSeek Harness 桌面版写入的 `DEEPSEEK_API_KEY`），无需复制密钥；也可用 `dshAgent.env` 注入 `DEEPSEEK_API_KEY`

## 安装

### 方式一：VSIX（推荐）

```sh
cd 插件/dsh-agent-vscode
npm install
npm run package          # 生成 dsh-agent-vscode-0.1.0.vsix
```

然后在 VS Code 中：**Extensions 视图 → ⋯ → Install from VSIX…** 选择该文件。卸载后工作区级设置、历史记录不受影响。

### 方式二：源码调试（F5）

1. 用 VS Code 打开 `插件/dsh-agent-vscode`。
2. 按 F5（已配置 `Extension Development Host` 调试配置）。
3. 在调试窗口打开 deepseek-harness 仓库作为工作区，点击活动栏的 **DSH Agent** 图标。

## 快速开始

1. 把 **deepseek-harness 仓库**作为当前工作区打开（扩展会自动探测运行时）。
2. 点击活动栏的 DSH Agent 图标（或 `Ctrl+Alt+D`）打开面板。
3. 在输入框发消息，例如：*「读取这个仓库的 README，总结它的架构，然后写一份三行的中文摘要」*。
4. 观察流式输出、思考过程、工具卡片与任务清单；完成后可「导出为 Markdown」。

首次发送消息时扩展会启动子运行时（`node packages/examples/jsonrpc-demo/lib/bin.js <配置>`，约 1–3 秒）。运行时退出会自动重启。

## 架构

```
VS Code (扩展)                     DeepSeek Harness (子进程)
┌────────────────────┐            ┌───────────────────────────────────┐
│ webview 面板        │            │ dsh-jsonrpc-agent bin             │
│  (media/main.js)    │            │  + examples/jsonrpc-agent/        │
│        ▲            │            │    vscode-agent.cordis.yml        │
│  postMessage        │            │       └─ dsh-sdk-jsonrpc-server   │
│        │            │            │       └─ dsh-agent-spine-demo     │
│  Controller         │  stdio     │       └─ bash / fs / subagent /   │
│  (src/*.ts)  ◄──────┼── JSON-RPC │          web / todo / skills /    │
│        │            │  行协议     │          compaction / credentials │
│  SessionStore/历史   │            └───────────────────────────────────┘
└────────────────────┘
```

- **协议**：扩展实现了 `@deepseek-ai/dsh-sdk-protocol` 的线协议（换行分隔 JSON-RPC 2.0）。`initialize` 握手后，`session/prompt` 入队消息，`session.event` 流式推送**每个持久化会话事件**（assistant/chunk 增量、assistant/message 提交、tool/call、tool/result、turn/end、session/title、todo/write），`session.status` 推送整 agent 的运行/空闲状态。`src/protocol.ts`、`src/runtime.ts` 是全部协议与进程逻辑所在。
- **运行时组合**：`media/cordis.yml` 会在首次启动时写入 `<repo>/examples/jsonrpc-agent/vscode-agent.cordis.yml`（位于 examples 解析树内，bare 插件名才能解析到 `examples/node_modules`）。可改用 `dshAgent.configPath` 指定你自己的组合。
- **凭据**：子运行时加载 `dsh-credentials-local`，从 `$DSH_HOME/.credentials.yaml` 读取密钥 —— 与 DeepSeek Harness 桌面版共享同一份凭据。
- **停止任务**：SDK 线协议没有逐会话取消方法，因此「停止」= 优雅 shutdown 子运行时并自动重启（会话归档保留）。
- **切换模型**：`initialize` 是进程级的，切换模型同样重启运行时（已归档会话保留在历史中）。

## 配置（设置 → 搜索 "dshAgent"）

| 键 | 默认 | 说明 |
|---|---|---|
| `dshAgent.repoPath` | 自动探测 | harness 仓库路径（含 `packages/examples/jsonrpc-demo`） |
| `dshAgent.configPath` | 内置组合 | 自定义 cordis.yml 绝对路径 |
| `dshAgent.systemPrompt` | 内置人格 | 支持 `{{cwd}}` 占位；修改后重启运行时生效 |
| `dshAgent.models` | V4 Flash / V4 Pro | `[{label, provider, model}]` 模型列表 |
| `dshAgent.maxTokens` | 16384 | 每个请求的输出 token 上限 |
| `dshAgent.env` | `{}` | 注入子运行时的额外环境变量（如 `DEEPSEEK_BASE_URL`、`HTTP_PROXY`） |
| `dshAgent.runtimeCommand` / `runtimeArgs` | `node` / `[]` | 自定义启动命令 |
| `dshAgent.autoRestart` | true | 运行时意外退出后自动重启 |
| `dshAgent.sessionRoot` | 扩展全局存储 | 会话日志目录 |

## 任务与一键运行

**直接运行当前文件**（编辑器标题栏右键 → DSH: 直接运行当前文件；或命令面板 `DSH: 直接运行当前文件`）：

| 文件 | 命令 | 问题匹配器 |
|---|---|---|
| `.py` | python | `$dsh-python` |
| `.js/.mjs/.cjs/.ts` | node | — |
| `.sh` / `.ps1` | bash / pwsh | — |
| `.c/.cpp/.cc/.cxx` | g++/gcc/clang 编译并运行 | `$dsh-gcc` |
| `.java` | javac + java | `$dsh-gcc` |
| `.go` / `.rs` | go run / rustc 编译运行 | `$dsh-gcc` |

**自定义任务**：在工作区创建 `.dsh-vscode/tasks.json`（命令 `DSH: 运行任务…`，首次运行可自动生成示例）：

```json
{
  "tasks": [
    { "name": "编译并测试", "command": "pnpm run test", "matcher": "$dsh-generic" },
    { "name": "构建 C++", "command": "g++ main.cpp -o build/main.exe && build/main.exe", "matcher": "$dsh-gcc" }
  ]
}
```

编译器/解释器输出会通过 problem matcher 自动进入 **Problems 面板**。

## 安全说明

本扩展按「无人值守、零授权弹窗」设计：子运行时组合**不包含审批层**，bash 与文件工具以当前用户权限直接执行。请仅在可信的工作区使用，并注意 `dshAgent.env` 中的密钥会被子进程继承。如需沙箱/审批，可自行提供 `dshAgent.configPath` 组合（参考 `examples/acp-agent/cordis.yml` 的 sandbox + approval 写法）。

## 故障排查

- **「未找到 deepseek-harness 运行时」**：把仓库作为工作区打开，或设置 `dshAgent.repoPath`。
- **发送消息无响应 / 初始化超时**：检查 `DSH_HOME`（默认 `~/.dsh`）下是否有 `.credentials.yaml` 含 `DEEPSEEK_API_KEY`；查看输出通道 **DSH Agent Runtime** 的子进程 stderr。
- **bare 插件解析失败**：确认配置位于 `examples/` 解析树内（默认已满足），且所需插件已声明在 `examples/package.json` 并执行过 `pnpm install`。
- **切换模型后旧会话消失**：这是设计行为 —— `initialize` 为进程级路由，旧会话已归档到历史中（只读），可随时导出。

## 参考

- 协议：[DeepSeek Harness SDK JSON-RPC 服务](../../packages/sdk/server/README.md)、[线协议类型](../../packages/sdk/protocol/README.md)
- 运行时组合模板：[examples/jsonrpc-agent/cordis.yml](../../examples/jsonrpc-agent/cordis.yml)
- 同类生态：[Agent Client Protocol (ACP)](https://agentclientprotocol.com)、[ACP VS Code 扩展](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin)、[Cline](https://github.com/cline/cline)、[Zed ACP 文档](https://zed.dev/docs/ai/agent-client-protocol)

## License

MIT
