# Codex with ChatGPT — 加固版

[English](README.md)

> ChatGPT 负责规划和审核，Codex 负责改代码、执行命令、测试和修复。

这个 Fork 保留了“ChatGPT 网页版负责思考、Codex 负责执行”的工作方式，同时
加固了本机 Bridge、凭证生命周期、进程停止、依赖管理和上游同步流程。
ChatGPT 能看到的 MCP 接口始终只读。

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
   `tunnel-client runtimes status <runtimeAlias> --json`。只有 process_running、healthy、
   ready 都为 true 且 stale 为 false，才把已有 runtime 视为健康；此时不要求当前 Codex
   进程带控制面变量。只有启动或重连 runtime 时，才检查该启动环境中是否存在
   CONTROL_PLANE_TUNNEL_ID 和 CONTROL_PLANE_API_KEY，全程不显示、打印或粘贴它们的值。
   所有参数以当前客户端 help 输出为准，禁止猜测命令行参数。
7. 如果当前账号或环境缺少 OpenAI Secure MCP Tunnel 访问条件，停止并准确报告阻断点。
   未经我明确同意，不得启用 Cloudflare。
8. ChatGPT 配置只使用内置浏览器界面。禁止向 ChatGPT 粘贴仓库文件、diff、密钥、
   Token、Cookie 或长日志；ChatGPT 必须通过只读 MCP 自己读取所需上下文。
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

配置结果会给出本机回环 MCP 地址、本机 Token 文件路径和官方 OpenAI Tunnel 客户端
使用的 runtime alias。OpenAI 控制面凭证只保存在运行环境中，不能打印、提交到仓库
或粘贴进 ChatGPT。

OpenAI Tunnel 不可用时，正确行为是停止并说明原因。只有得到用户明确批准，才可以
切换到 Cloudflare 备用方案：

```bash
node bin/c2c.js transport -w <workspace> --mode cloudflare --json
```

恢复加固默认模式：

```bash
node bin/c2c.js transport -w <workspace> --mode openai --json
```

传输模式切换受生命周期锁保护。切换失败时会恢复旧模式，也不会为未完成的模式创建
新的凭证。

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
