# 2026-09-06 上游逐项处理与 C2C 恢复记录

## 范围与可恢复基线

仅处理 `wxst/codex-with-chatgpt`。核对时本地 main 与 origin/main 均为
`933e00454cb70b9b16d7f299c7f6673f4c4f8dac`，工作区干净，默认分支为 main。
远端镜像为 `a9f91cd98df1bc82686f57d5bc2b2993394c93be`。共同祖先之后
main 独有 26 个提交，镜像独有下列 15 个提交。比较使用 `git show` 和源码，
没有切换共享工作目录，也没有整体合并或制造空合并提交。

仓库外备份：
`C:/Users/jack/Documents/Codex/c2c-archives/c2c-20260906-before-cleanup.bundle`。
通过 `git bundle create <path> --all` 保存当时所有引用；`git bundle verify`
确认完整历史及 8 个引用可用。恢复时在另一个空目录执行
`git clone <bundle-path> <recovery-directory>`；需要镜像时再执行
`git fetch <bundle-path> refs/remotes/origin/upstream-main:refs/heads/recovered-upstream`。
不要用恢复操作覆盖当前工作目录。

## 15 个提交的去向

“已有”表示行为已实现，不表示提交图已合并。证据路径均相对本仓库。

| 上游完整 SHA | 处理 | 源码及验证证据 |
| --- | --- | --- |
| `a9f91cd98df1bc82686f57d5bc2b2993394c93be` | 已有兼容部分；不引入日志扩展字段 | `src/execution/records.ts` 的 Zod 校验、倒序筛选有效记录；`src/workspace/manager.ts` 的 `parseProjectConfig`、`stringRecord`；`src/cli/index.ts` 的安全整数解析。`tests/record-cli.test.ts`、`tests/workspace.test.ts` 验证非法来源。上游 `outputId/outputAvailable` 属于本次不引入的第九工具功能。 |
| `fe79d2d396d1181544f5f108ee9a51fb09e61f34` | 已有八个工具的结构化实现 | `src/mcp/server.ts` 八个 `outputSchema`，成功结果同时提供文本和 `structuredContent`，失败不伪造成功结构。`tests/mcp-integration.test.ts`、`tests/router-mcp.test.ts` 验证实际 HTTP MCP、任务路由及工具数量。上游日志输出工具不引入。 |
| `96522347d0dd121fa3959957bc9727e74de9faab` | 无需引入 | 撤销上一条英文标题修改；当前 `docs/troubleshooting.md` 已保留该标题，重复应用无收益。 |
| `fac1fc9316b1ced694b96d7da577b5bec00b1374` | 无需引入 | 仅改英文标题，随后被 `9652234` 撤回，无最终功能差异。 |
| `1f8fdb4ed7bc1107b0ae84a73fd1e440c34fa07c` | 无需引入 | 当前 `README.md` 已重写为 Router/任务池说明，没有该旧登录段落。 |
| `3cf0a60a7917108a20c0c510fc8c5844b3d18632` | 无需引入 | 当前 `skill/SKILL.md` 已重写为宿主控制工具流程，不存在该旧浏览器恢复句。 |
| `0b70588cd5b76d035ad9448e6992ab4dbea1d633` | 已有，移植时保留 | `src/tunnel/cloudflared.ts` 的 `windowsHide: true`；新增注入启动函数仍携带该参数。`tests/tunnel.test.ts` 实际检查调用参数，`tests/background-processes.test.ts` 保留所有后台进程约束。 |
| `d3cdd08b78d0002444596906cd0a8ba4aefc4beb` | 已有 | `src/tunnel/cloudflared-named.ts` 已隐藏窗口；后台进程契约覆盖。 |
| `831cbb985d4d84e9536c6ab33e8cdbab6317cc62` | 已有 | `src/process/daemon.ts` 已隐藏窗口；后台进程契约覆盖。 |
| `9e56bf86755b1efdb1e5b7271f46f59bfb82e330` | 本次选择性移植 | 原 main 仅看到 URL 即成功，缺少公网健康确认；移植 `src/tunnel/cloudflared.ts` 和对应 `tests/tunnel.test.ts`，保留 main 的 Windows 隐藏窗口要求；在 `src/tunnel/detect.ts` 最小加入可访问文件及 `C2C_CLOUDFLARED_PATH` 支持。验证 API/伪后缀地址拒绝、错误服务、超时、进程退出、停止、并发启动、重试及运行期日志。Router 使用相同 Bridge `/health` 契约，无须改变 MCP 或任务权限。 |
| `d6d0dd4e866fd9253572fcf84d8414132838d6f9` | 核心保护已由当前生命周期实现；不回退旧探测模型 | `src/bridge/server.ts` 的 `assertNoActivePersistedBridge` 在创建凭据前检查持久进程代次，`match/unknown` 拒绝第二个 Bridge；`src/process/daemon.ts`、`startup-registry.ts` 使用锁与启动意图。`tests/lifecycle-lock.test.ts` 验证同 workspace 重复启动拒绝。当前实现不照搬上游仅凭 PID 的判断，保留旧无代次记录的认证探测路径；不宣称瞬时启动器进程绝不会创建。排障文档补充“不确定探测不授权替换连接器”。 |
| `5131cea1916b4b1b1cad07beb2d28e7e13b77081` | 无需引入 | 本仓库 `package.json` 与 `src/version.ts` 一致为 0.1.0；此次按 Git main 提交交付，没有单独发布上游 0.1.1 软件包的任务，不为追平图而改版本。 |
| `93dc6acf87c919805632d2bb5eda559f324ee856` | 本次不引入 | 上游 `src/config/ui-prefs.ts`、`prefs` CLI 和 Skill 是旧浏览器自动/教学设置偏好；当前 `skill/SKILL.md` 使用宿主精确 Chat 控制工具、已确认池设置和 Router。额外设置产品流程不属于恢复任务，不能用机器偏好代替宿主能力检查。 |
| `e3281af2dee9d97e56ef795c60b899d0a117c3b0` | 不引入旧会话及日志工具；保留现有恢复能力 | 上游新增命令输出读取工具、sanitize/output 存储和单 workspace checkpoint。当前 `src/session/state.ts` 已有任务账本、租约、`resumeTaskSession`、`switchTaskWorkspace`、消息回执；`src/mcp/server.ts` 保持八个只读工具。禁止为吸收提交扩大工具范围或恢复旧会话归属。 |
| `e598ff493108d05647db9049a27e9102ab51b39c` | 路径替换已有；旧人工浏览器回退不引入 | 当前 `skill/SKILL.md` 使用 `__C2C_CHECKOUT__` 安装替换；本次补齐新版 `confirm-workspace` 示例和四个真实观察字段。安装时替换实际 checkout 后检查无占位符、内容一致、入口可执行。上游回退要求删除单 workspace 连接器，不适用于当前共享 Router/宿主消息控制。 |

## 分支、标签和 worktree

- 本地只有 main，远端只有 main 和 upstream-main，没有打开的 PR；没有功能分支需合并或删除。
- 本次选择性移植上述 Quick Tunnel 修复到 main，没有合并 upstream-main。
- 远端 upstream-main 保留：`.github/workflows/upstream-sync.yml` 用它保存上游镜像并发起审核。
- 两个已有归档标签 `archive/hardening-v1-b837538` 和
  `archive/review-findings-2d99df2` 均在本地、远端及 bundle，保留不变。
- C2C 只有当前 main worktree；无清理对象。未动 codex-memory-pro 的业务分支、PR、worktree。

## 正确 #40 消费者回执

由原协调 task 自身执行确认，主协调重新读取同一 Chat 及账本核实：

| 字段 | 观察结果 |
| --- | --- |
| task | `01a07295-ab0f-7953-a8b8-fe82e0a93ec1` |
| workspace | `6062e514e469` |
| Chat | `6a9b189e-251c-83ea-8249-0d27be28b5f0` |
| generation | `2` |
| BOOT iteration / message | `19` / `c2c_msg_532c4a13-3782-4abc-a12e-f3d381a9839b` |
| 工具观察 | workspaceId 与 routeTaskId 匹配上列值；workspaceName=`codex-memory-pro`；git.branch=`codex/issue-40-context-compat` |
| 结果 | 宿主接受、同 Chat 用户消息送达读回、匹配 DONE 登记、新版确认成功 |
| 最终账本 | `verificationState=ready`、`channelState=ready`，无 pending message、无 active use；租约正常释放 |
| 账本保存时间 | `2026-09-06T12:47:49.047Z` |

验收执行于 `933e00454cb70b9b16d7f299c7f6673f4c4f8dac` 的已构建入口。
本次后续代码只修改 Quick Tunnel provider/二进制发现，未改变身份确认、消息流程、
Router MCP 或消费者正在使用的服务；身份确认通过补充测试验证，未为此重复发送 BOOT。
这不是新 Quick Tunnel 的生产启动回执。没有重启运行中 Router/Tunnel，也没有启动业务实现。
记录中不保存 route token。

## 验证

针对新增会话、宿主 CLI、Router MCP 和 Quick Tunnel 的首次相关检查为 4 文件 80 测试通过。
最终完整测试为 44 文件、505 测试通过（119.02 秒）。首次完整运行是 504 通过、
1 失败：未改动的 `runtime-config.test.ts` 在 Windows 临时文件重命名时遇到 EPERM；
单独复查 9/9 通过，再完整复查得到上述 505/505。没有删除或放宽失败断言，
不把这次瞬时失败称作已定位根因的代码缺陷。两次日志分别保留在本机临时目录的
`c2c-final-20260906-tests.log` 和 `c2c-final-20260906-tests-confirmation.log`。

`pnpm typecheck`、`pnpm build`、`pnpm smoke:install`（Windows x64）和
`git diff --check` 均通过。安装 Skill 为 UTF-8 无 BOM，内容与源模板替换实际
checkout 后一致，`session confirm-workspace --help` 可执行。
发布 SHA 的远端 CI 结果在交付时单独报告，不使用旧 HEAD CI 或消费者回执代替新提交检查。
