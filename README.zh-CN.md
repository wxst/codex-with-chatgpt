# Codex with ChatGPT — 加固版

[English](README.md)

> ChatGPT 负责探索、规划、诊断和复核，Codex 负责执行与验证。

这个 Fork 保留了“统一 Codex App 内的 ChatGPT 负责思考、Codex 负责执行”的工作方式，同时
加固了本机 Bridge、凭证生命周期、进程停止、依赖管理和上游同步流程。
ChatGPT 能看到的 MCP 接口始终只读。

宿主 `read_thread` 可能遗漏网页上已有的回复。出现
`read_exact_chat_in_browser` 时，协调者自动只读核查精确 `chatUrl`，记录
浏览器来源，并通过普通 `confirm-reply --observed-reply-file` 校验原回复。
禁止浏览器发送和私有 Chat API。旧工作区有 pending 时先使用回执命令的
`--bound-workspace` 对账并释放自己的租约，再正常迁移同一 Chat；不清除或重发旧请求。

## 日常使用：先交给 ChatGPT 分析

利用 ChatGPT 订阅额度承担代码探索、方案比较、根因分析、测试设计和复核，
减少 Codex 在这些环节的额度消耗。Codex 检查任务范围和连接后，按
`ready → INIT → PLAN → execution → EXECUTED → PLAN / DONE / BLOCKED` 工作。
BOOT DONE 只证明连接；有效 PLAN 必须有源码依据、行动、测试和成功标准。
Codex 按计划执行并回传证据，不重复整套探索。模板和送达步骤见
[Skill](skill/SKILL.md#daily-reasoning-workflow)。

每个新业务任务、Chat 轮换后及 workspace 迁移后，都必须由
`session prepare-init --input-file <UTF-8 JSON>` 生成 INIT。ChatGPT 首先调用
`memory_start_task`，需要历史时用 `memory_search`；Gitea 工作按需用只读
`codewiki_*`、`gitea_*`。八个只读 C2C MCP 工具是当前工作区、diff 和执行记录的最终依据。
只有实际 mem 初始化成功才是 READY；DEGRADED 必须说明原因，不能声称缺失分析已完成。

每次续接先运行 `session get`，然后严格跟随 `nextAction`。`get` 不返回租约 id。
真实 `CODEX_THREAD_ID` 与任务唯一权威绑定 owner 匹配时，
`session resume --recover-own` 恢复同一个现有租约；缺失、过时或普通内容损坏的
续接缓存由 CLI 根据账本重建。当前没有租约时仍按 `nextAction` 处理 pending 和无租约预检，
只在后续动作需要时获取新租约。缓存缺失不表示“另一个 coordinator”占用。
任务没有绑定或证据确认绑定失效时，从固定池选择最久未使用的安全会话。

pending 必须先对账原消息；read_thread 可用时，即使发送工具缺失也继续读取，不重发、
不换 Chat、不把本地只读分析当作 ChatGPT 分析。按 `coordinatorAction` 和
`businessGate` 处理，CLI 不会后台轮询。弱 PLAN 确认回执后用 `--kind analysis` 补充。
通道阻塞时保留绑定并报告，不默认将全部思考交回 Codex。

带 `REVIEW_HEAD` 的 INIT 或 ANALYSIS 回复若四项回执身份匹配但漏回 HEAD，先确认其实际
传输回执，再遵循 `review_head_clarification_required`：刷新预检、发送带同一 HEAD 的
ANALYSIS 补充请求。不得填造 HEAD、重发 INIT 或发送 EXECUTED；只有补充回复精确回显后
才能继续。

## 本轮安装试用范围

当前版本用于以下环境的首次受控安装试用：

- Windows，Node.js 20 或更高版本；
- 兼容的 Linux，Node.js 20 或更高版本，并具备 Python 3.9+、
  `os.pidfd_open` 和 `signal.pidfd_send_signal`。

Linux 会在 Bridge 读取或创建任何凭证之前真实执行安全能力检测；条件不满足时
直接拒绝启动，不会降低安全标准继续运行。

默认连接方式是 **OpenAI Secure MCP Tunnel**。Cloudflare 仅保留为用户明确批准
后才可启用的兼容备用方案，绝不会自动打开。

## 直接交给 Codex 的安装提示词

把下面整段原样交给 Codex。它会安装你的加固 Fork、固定依赖、运行全部门禁，
并使用仓库内的真实 CLI 入口，不依赖系统里是否存在全局 `c2c` 命令。

```text
请为我安装并准备加固版 Codex with ChatGPT，目标是完成一次受控安装试用。
技术工作全部由你完成；只有账号登录、验证码、两步验证或确实需要我提供
OpenAI Tunnel 凭证时才能打断我，而且一次只让我做一个动作。

1. 先确认当前系统是 Windows 或兼容的 Linux。必须具备 git 和 Node.js >= 20。
   Linux 还必须具备 Python >= 3.9，并实际确认 os.pidfd_open 和
   signal.pidfd_send_signal 可用；需要时设置 C2C_PYTHON。无法满足加固进程安全
   前置条件时立即停止，不得降级绕过。
2. 只克隆 https://github.com/wxst/codex-with-chatgpt 的 main 分支到独立目录。
   如果目录已经存在，先核对 remote、分支和工作区状态；禁止自动覆盖本地修改，
   禁止自行拉取更新。
3. 进入仓库执行：
   corepack enable
   corepack pnpm install --frozen-lockfile
   corepack pnpm typecheck
   corepack pnpm test
   corepack pnpm build
   corepack pnpm smoke:install
4. 用下面两条命令验证仓库内真实 CLI：
   node bin/c2c.js --version
   node bin/c2c.js --help
   后续不得假设系统中存在全局 c2c 命令。
5. 把 skill/SKILL.md 复制到 Codex Skill 目录中的
   codex-with-chatgpt/SKILL.md。只在复制后的安装文件里，把全部
   __C2C_CHECKOUT__ 替换为仓库绝对路径；不要把机器路径写回仓库模板。
6. 针对目标代码工作区，严格按安装后的 Skill 做首次配置。保持 openai 传输模式。
   检查官方 OpenAI tunnel client，从 setup 结果读取 `runtimeAlias`，先执行
   `node bin/c2c.js runtime diagnose -w <workspace> --json`。C2C Runtime 只读取
   `.config/codex-with-chatgpt` 下的 CurrentUser DPAPI Key 与 Tunnel ID 文件；用户环境和
   Codex 父进程里的 Key 均在调用链外。只有 process_running、healthy、ready 都为 true
   且 stale 为 false，才把已有 runtime 视为健康。所有参数以当前客户端 help 输出为准，禁止猜测命令行参数。
7. 如果当前账号或环境缺少 OpenAI Secure MCP Tunnel 访问条件，停止并准确报告阻断点。
   未经我明确同意，不得启用 Cloudflare。
8. 首次使用前，在 **Codex-with-ChatGPT** Project 手工准备备用普通 Chat：选择非 Pro、
   思考强度“极高”，并发送一条只含 `C2C_STANDBY_READY` 的用户消息。后续任务由后台领取
   精确会话。禁止向 ChatGPT 粘贴仓库文件、diff、密钥、Token、Cookie 或长日志；ChatGPT 必须
   通过只读 MCP 自己读取所需上下文。
9. 安装和正常使用期间禁止自动更新仓库、升级依赖、执行自动更新命令或自动同步上游。
10. 最后给出有证据的验收清单，包括：实际 commit、依赖安装、typecheck、全部测试、
    build、安装烟雾测试、CLI 版本、传输模式、Bridge 状态和 MCP 文件读取验证。
```

## 手动下载与验证

```bash
git clone --branch main --single-branch https://github.com/wxst/codex-with-chatgpt
cd codex-with-chatgpt
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:install
node bin/c2c.js --version
node bin/c2c.js --help
```

这个项目按“已构建的仓库”使用，不要求全局安装。文档中的 CLI 统一写成：

```bash
node bin/c2c.js <命令>
```

## 安装 Codex Skill

把 `skill/SKILL.md` 复制到：

```text
~/.codex/skills/codex-with-chatgpt/SKILL.md
```

只在复制后的安装文件中，把 `__C2C_CHECKOUT__` 替换为当前仓库的绝对路径。
仓库内的 Skill 模板保持不变，便于审核和升级。

## 第一次配置工作区

在 C2C 仓库目录执行，并把 `<workspace>` 换成真实项目路径：

```bash
node bin/c2c.js sandbox-allow --json
node bin/c2c.js transport -w <workspace> --mode openai --json
node bin/c2c.js setup -w <workspace> --json
```

配置结果会给出本机回环 MCP 地址、本机 Token 文件路径和托管 runtime alias。C2C
Runtime 的唯一控制面凭据来自
`%USERPROFILE%/.config/codex-with-chatgpt` 下的 CurrentUser DPAPI 文件；它绕过用户
环境和父进程继承的 Key。Key 不会打印、提交到仓库或粘贴进 ChatGPT。

OpenAI Tunnel 不可用时，正确行为是停止并说明原因。只有得到用户明确批准，才可以
切换到 Cloudflare 备用方案：

```bash
node bin/c2c.js transport -w <workspace> --mode cloudflare --json
```

恢复加固默认模式：

```bash
node bin/c2c.js transport -w <workspace> --mode openai --json
```

## 全局 Router 与备用 Chat

升级已有连接时，在当前已连接工作区运行一次：
`node bin/c2c.js router migrate -w <anchor-workspace> --json`。后续项目运行
`router ensure` 即可注册，复用原来的 OpenAI Secure MCP Tunnel 和 ChatGPT
连接器。
随后运行 `node bin/c2c.js session migrate --json`，它会在全局锁内备份旧记录并
写入统一归属账本。
旧版“三次读取缺失”留下的 `unavailable` 记录，先通过后台 `read_thread` 核对原 Chat；
身份一致时使用 `session restore --confirm` 恢复原会话，避免额外消耗库存。

每个 Codex 任务复用固定 10 个 Chat 中的一个当前绑定。健康绑定自动续用；只有当前任务没有绑定，
或有新鲜证据确认原 Chat 已无法继续时才轮换。按 `lastUsedAt` 从旧到新核实并选择首个安全候选；
缺少续接缓存不代表 Chat 失效，也不要求用户增加备用 Chat。
用户准备库存时选择非 Pro、思考强度“极高”，并发送一条只含 `C2C_STANDBY_READY` 的用户消息。
编辑器可能保留为字面文本 `C2C\_STANDBY\_READY`；两种完整拼写都可识别。明确要求 Pro 时，
只使用 `C2C_STANDBY_READY_PRO` 的库存 Chat。

领取前先解析当前任务绑定。`session pool reclaim-candidates` 提供本地候选及排除原因，
不代表宿主已证明空闲。`notLoaded` 必须用同宿主前后两次 inactive 快照、同一个已完成轮次、
精确 Chat 读回、匹配回执和逐项新鲜时间证明。不得强占 pending、未决发送、有效租约或忙碌 Chat；
逐一核查全部候选并记录真实原因后才能报告阻塞。旧 owner 身份本身不构成排除理由。

领取和工作区迁移只建立绑定。完成宿主预检后运行
`session prepare-boot --expected-generation <n> --use-id <own-id> --json`。
普通 JSON 不含 token 或正文；私有 messageFile 是 JSON，只在内存中读取并校验后，将 `body` 字段
发给精确绑定 Chat。Windows 文件只允许当前用户和 SYSTEM，Unix 使用 `0700`/`0600`。
重复调用保留同一 preparation 和消息身份；已 pending 或发送结果不明时必须读回，不能重发。
8 个 MCP 工具仍通过 `route_token` 解析到唯一绑定工作区。

同时给出 `CODEX_THREAD_ID` 和 `--task-id` 时，两者必须完全一致；值不同时会先返回
`TASK_ID_IDENTITY_MISMATCH`，账本保持原样。Boot 回复还要带上 `workspace_info` 实际返回的
`routeTaskId`、`workspaceName` 与 `git.branch`；`CONNECTOR` 只是本地显示和选择名称，
不是工具返回值，也不参与身份验证。只有回执字段时，验证继续保持 pending。

修改托管 Runtime 前，运行 `node bin/c2c.js runtime diagnose -w <workspace> --json`。
Runtime 唯一 Key 来源是 `%USERPROFILE%/.config/codex-with-chatgpt/tunnel-runtime-key.dpapi`。
短生命周期子进程先清理继承的控制面 Key，再读取该 DPAPI Key 并读取精确 Tunnel。
`credentialSource: managed_dpapi` 加 `credentialState: verified` 表示验证通过；
`credentialState: invalid` 表示这把 DPAPI Key 收到 `401 invalid_api_key`，此时才进入轮换流程；
`missing` 表示 DPAPI 文件需要恢复。令牌文件路径修复与 Runtime Key 健康状态保持分离。

Windows 上由 `scripts/start-managed-openai-tunnel.ps1` 统一负责托管 Runtime
的启动、重连、watchdog 和停止。它只把新解密的 DPAPI Key 注入短生命周期的
`tunnel-client` 子进程，并以 `c2c runtime diagnose` 查询状态。不要从继承的
Codex/用户环境直接调用 Runtime status 或 stop。
## 正常使用

Skill 安装并完成连接验证后，直接对 Codex 说：

```text
使用 Codex with ChatGPT 完成 <任务>。
```

Codex 始终掌握执行权。ChatGPT 只能通过以下 8 个只读 MCP 工具规划和审核：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`

ChatGPT 侧不存在写文件、删除、Shell、安装依赖或 Git 提交工具。

## 安全与维护方式

- OpenAI 模式下 Bridge 只监听本机回环地址，并要求每工作区随机 Token。
- 常见密钥和凭证路径默认拒绝读取；项目特殊文件继续用 `.c2cignore` 排除。
- `unpair`、`stop`、重启、启动失败清理和传输模式切换共用生命周期隔离，能够跟踪
  所有 pending start 和 runtime generation。
- 直接依赖和 GitHub Actions 固定版本。
- 运行期间不自动更新。
- `main` 是实际安装使用的加固分支。
- `upstream-main` 仅镜像原始上游。
- 上游更新只能形成审核 PR，验证任务为只读权限，绝不自动合并。

详细说明见 [HARDENING.md](HARDENING.md)、[安全文档](docs/security.md) 和
[故障排查](docs/troubleshooting.md)。

如果续接任务后缺少 `read_thread` / `send_message_to_thread`，参见
[宿主控制工具诊断与恢复](docs/host-control.md)。先检查当前执行器工具清单，
保留原绑定和在途消息；工具恢复后先读取原 Chat，再继续对应 HEAD 的回执。

## 开发与发布门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:install
```

## 当前状态

加固版安装试用候选版本。非 OpenAI 官方项目，与 OpenAI 无隶属或背书关系。

## 许可证

[MIT](LICENSE)
