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
- 新 BOOT（首次分配、池内轮换、workspace 迁移和恢复）只能用 `session prepare-boot --expected-generation <n> [--use-id] --json`。`pool claim` 与 `switch-workspace` 只变更绑定，不能签发或输出 token；`begin-send --bootstrap` 不能绕过此入口。
- `prepare-boot` 的普通输出只含身份、代次、摘要、消息 ID 和私有 `messageFile` 路径。完整 BOOT 正文和 route token 仅存在该进程外私有材料文件：Windows 只允许当前用户和 SYSTEM，Unix 目录 `0700`、文件 `0600`。协调者只在内存中读取原文并发给精确绑定 Chat，不在日志、JSON、观察文件或错误中复制 token。
- 重复 `prepare-boot` 必须恢复同一 preparation、正文、capability、message ID 和 iteration。首次调用已预留后若输出丢失，先同 Chat 对账；只有 `host-control --result not-invoked --confirm-not-invoked` 证明发送工具从未调用，且重新完成所需预检后，才可用同一正文重新预留。已接受、送达、等待回复或已完成的 BOOT 绝不换 token、重发或换 Chat。
- `prepare_boot_required` 与 `resume_boot_preparation` 是自动恢复动作。迁移 BOOT 确认并执行 `confirm-workspace` 后自动清理私有正文；清理失败保留脱敏 preparation 记录以便重试，不能倒退 ready 或重新签发。
- 未完成迁移的目标 BOOT 已送达且得到匹配 `DONE`、无 pending 时，`session get`/`resume` 必须返回 `migration_workspace_confirmation_required`；主协调者立即读取目标 C2C `workspace_info` 并执行 `confirm-workspace`。不得重新核对源 INIT、重发 BOOT、换 Chat 或把本地/Gitea 工作描述成已经完成 ChatGPT 委派。源回执缺少 `REVIEW_HEAD` 时保持省略，不能用普通 HEAD 填充。
- 工作区解析优先于迁移子状态：在旧或其他 workspace 调用且无 pending 时，`session get`/`resume` 返回 `switch_workspace`；有 pending 则先对唯一源绑定执行 `reconcile_source_pending`。其他协调者租约和 `restore_host_tools_then_read_bound_chat` 仍优先，不得把工具缺失误报为迁移 preflight。宿主返回内容不完整时使用下述只读浏览器观察，不放宽发送权限。

## 消息等待与恢复

- `read_thread` 的 completed/idle 和空读可能遗漏网页上已经存在的回复。出现 `read_exact_chat_in_browser` 时，自动用受支持浏览器只读打开 get/resume 的精确 `chatUrl`，核对最终 URL 与实际助手正文；不得继续只轮询同一个不完整来源。禁止浏览器发送、重生成、编辑、删除和私有 Chat API。
- 浏览器观察记录 `source=browser`、实际 `sourceUrl` 和读取时间，不伪造宿主轮次字段。看到匹配回复后，保存精确 UTF-8 正文，用普通 `confirm-reply --observed-reply-file` 完成原消息确认；INIT 的送达摘要、REVIEW_HEAD、mem 和租约校验仍必须通过。只有 visibility hint 不算确认。浏览器不可用则如实记录 observation_blocked，不清 pending、不重发、不换 Chat。
- 当前 worktree 与绑定工作区不同且有 pending 时，先按 `reconcile_source_pending` 对账原 Chat。使用当前任务自身身份以及回执命令的 `--bound-workspace`，保留源 workspace 身份；无需旧目录存在。确认后用 `finish --bound-workspace --use-id` 释放自己的旧租约，再执行正常迁移。该入口不能发送新业务消息，也不允许操作其他任务。

- pending 是主协调者必须持续处理的工作，不是汇报后可搁置的状态。每次续接先 get；持有租约时用 resume --use-id 幂等续接，不重新领取，也不使用其他协调者的租约。
- 按 coordinatorAction 执行读取、等待至 readbackDueAt、精确确认、诊断或恢复观察；记录每次真实读取。到期读回优先于可选本地工作，CLI 不会替协调者后台轮询。
- businessGate 区分 BOOT、INIT/ANALYSIS、EXECUTED 和历史消息等待。ready 或 PLAN 回显不等于业务验收；依赖该回复的分析、修改或发布不能越过等待。只读的本地/记忆/Gitea 分析也不是自动豁免，Superpowers 等通用流程必须保留读回责任。
- 完整用户方案允许的独立、确定性工作可交错执行，但不能拖延到期读回。真实宿主健康/分页诊断无法提供结果时，记录 observation_blocked、errorCategory=unavailable 和脱敏 blockedReason，报告可恢复的观察阻塞；不得凭 idle、completed 或等待时长判失败。续接后重新观察同一请求。
- 所有回执变更命令均传自己的 --use-id（无租约时省略）；弱 PLAN 先确认回执，再用 --kind analysis / STATE: ANALYSIS 请求补充，不能伪造 EXECUTED 或重新发送旧消息。
- 带 `REVIEW_HEAD` 的 INIT 或 ANALYSIS 若四项身份、状态和 mem 字段都匹配但漏回 HEAD，先用实际正文完成该条传输回执；CLI 必须返回 `review_head_clarification_required`。保留原回执，完成新鲜预检后发送带同一 HEAD 的 `STATE: ANALYSIS` 补充请求。不得填造 HEAD、重发 INIT 或发送 EXECUTED；只有匹配的补充回执才能解除门禁。
- 首次 BOOT DONE 后仍须按 workspace_confirmation_required 完成实际 workspace_info 与 confirm-workspace（携带自身租约）；旧代 DONE 不代表当前 BOOT。迁移继续使用独立迁移动作，不重发 BOOT。

- get、resume、host-control 使用统一恢复决策：工作区、其他协调者租约及工具可用性优先，随后对账 pending，再完成迁移或续接。
- 送达与回复独立计时：前 60 秒每 5 秒、之后每 15 秒、超过 5 分钟每 30 秒读取；单次等待不超过 60 秒。十五分钟触发健康和分页诊断，不自动判失败。
- idle、completed、空页、超时均不证明没有回复。每次从最新页读起，按需分页定位精确请求和回复；用 session record-readback 记录真实观察，不能改写已确认送达进度。
- 续接及新消息前必须先对账 pending；晚到回复仍确认原消息，不重发、不换 Chat。工具无法读取时报告具体阻塞，恢复后继续同一请求。
- 无 pending 且预检过期时先刷新预检。发送前必须核实预留命令退出成功、ok=true 且消息身份匹配；失败后不得继续调用发送工具。持有租约时向 get/host-control 传自身 use-id。
- 匹配 PLAN 回执先确认，再审查代码依据、行动、测试和成功标准；内容不足另发补充请求。MEMORY_STATUS READY 声明不能代替真实 mem/MCP 工具证据。
