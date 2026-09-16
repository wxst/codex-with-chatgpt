# 本仓库工作约定

- 默认直接在 `main` 开发，不自动创建功能分支或 worktree；用户明确要求时才例外。
- 开始修改前核对当前分支、工作区和远端状态，保留其他任务的未提交改动，不重置或覆盖。
- 并行 agent 明确文件归属；由主协调者统一提交、验证和发布。
- `upstream-main` 只作上游同步镜像，不作为开发分支；按现有架构选择性吸收改进。
- 发布采用正常 push，不强推或重写共享历史。发布范围按当前用户授权执行。
- 保持现有 8 个只读 MCP 工具、Router 任务权限和 Chat 绑定；未经任务授权不重启运行中服务。
- 自动化通过、远端 CI、真实宿主回执分别报告。工单默认保持 open，不能用旧 HEAD 回执代替当前审核。

## 固定 Chat 池与自动轮换

- 固定复用现有 10 个 Chat，不要求用户增加备用对话，也不新建任务绕过验收。
- 健康绑定正常续用；需要分配时，按 `lastUsedAt` 从旧到新核实，自动选择第一个安全可用的 Chat。旧任务绑定本身不是排除理由。
- 当前绑定失效时，先核实宿主调用路由并恢复；确实不可用且无未决发送时，走池内原子轮换，不能以“已有绑定”为由停止。
- ChatGPT 对话发送只传精确 conversation ID，不传 Codex 的 `hostId`。`no rollout found` 不证明 Chat 已删除。
- 原任务 `notLoaded` 需要同宿主即时不活跃快照、已完成且不变的轮次、精确 Chat 读回及新鲜回执证据；不得伪装为 `idle`。
- 忙碌、pending、未决发送或其他协调者租约不得强占。逐个检查全部候选并记录实际原因后，才能报告阻塞；证据采集与调用由主协调者完成。
- 轮换保留历史、撤销旧能力、保证唯一绑定。自动测试通过不代替真实同 Chat 的 BOOT、MCP 读取、INIT/PLAN/EXECUTED/DONE 与租约释放验收。

## C2C 业务任务的 ChatGPT mem 初始化

- 每个新的 C2C 业务任务、Chat 轮换后和 workspace 迁移后的首个业务 INIT，必须使用 `session prepare-init --input-file <UTF-8 JSON>`。不得手写 INIT 或用 `begin-send` 绕过；旧 Chat 残留的 mem 上下文不代表当前 generation 已初始化。
- 生成的 INIT 强制 ChatGPT 先调用 `memory_start_task`，参数固定为当前目标、约束和成功标准、`memoryProject`、`detail="standard"`、`intent="start"`、`mode="hybrid"`、`includeProjectContext=true`。缺少历史或文档时使用 `memory_search`。
- Gitea 工作按需用只读 `codewiki_*`、`gitea_*` 读取 Wiki、仓库和工单；C2C 八个只读 MCP 工具读取当前本地源码、diff 和执行记录，并在冲突时优先。未经用户另行授权，不调用 `memory_write_summary`、Gitea 写工具或其他写接口。
- INIT 的精确 Chat 读回必须以 `--observed-message-file` 校验摘要；回复必须记录 `MEMORY_PROJECT`、`MEMORY_STATUS`、`MEMORY_SOURCES`，`DEGRADED` 还须记录具体 `MEMORY_REASON`。`READY` 仅表示实际初始化成功；`DEGRADED` 保留原因并继续使用 C2C 本地证据。
- 只有当前 generation 已记录 `READY` 或 `DEGRADED` INIT 时才可发送 `begin-send --kind executed`。generation、Chat 或 workspace 改变会清除该记录，必须重新初始化。
- C2C 自身的回执对账、错误 BOOT 修复、迁移握手、租约释放、终态绑定退役及固定池安全轮换属于已授权的内部恢复；主协调者自动完成，不再向用户索取单独授权。该约定不扩大到发布、部署、重启、凭据或其他任务的 pending/租约。
- 未完成迁移的目标 BOOT 已送达且得到匹配 `DONE`、无 pending 时，`session get`/`resume` 必须返回 `migration_workspace_confirmation_required`；主协调者立即读取目标 C2C `workspace_info` 并执行 `confirm-workspace`。不得重新核对源 INIT、重发 BOOT、换 Chat 或把本地/Gitea 工作描述成已经完成 ChatGPT 委派。源回执缺少 `REVIEW_HEAD` 时保持省略，不能用普通 HEAD 填充。
- 工作区解析优先于迁移子状态：在旧或其他 workspace 调用时，`session get`/`resume` 必须先返回 `switch_workspace`。宿主缺少精确 Chat 的读取或发送工具时，必须先返回并完成 `restore_host_tools_then_read_bound_chat`，不得误报普通迁移 preflight，也不得在工具尚不可用时尝试源读回或目标 `workspace_info`。
