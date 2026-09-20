# 本仓库约定

- 默认在 main 开发。修改前检查分支、工作区和远端；保留他人改动，不重置、不覆盖。
- upstream-main 只作上游镜像，按项目架构选择性吸收改进。
- 发布使用正常 push，不改写共享历史；提交、推送、合并、部署和重启按当前用户授权范围执行。
- 保持 Router 的 8 个只读 MCP 工具和任务隔离。除非任务明确包含，不重启运行中服务。
- 自动测试、远端 CI、宿主真实回执和部署结果分别报告。工单默认保持 open，不能用旧 HEAD 回执代替当前审核。

## C2C 操作原则

本仓库的安装版 Skill codex-with-chatgpt 是日常 C2C 操作流程的唯一详细说明。严格执行其中的恢复决策表、命令和证据格式；不要从旧对话或其他文档片段拼出第二套流程。

- 固定复用现有 10 个 Chat。绑定健康时继续使用；无空闲库存时按 lastUsedAt 从旧到新核实，自动选第一个安全候选。不得要求增加 Chat。旧 owner 身份本身不代表忙碌。
- 只有主协调者操作 C2C；子 agent 只回报发现。ChatGPT 调用只使用精确 conversation id，不带 Codex hostId。no rollout found 先核对路由。
- 每次续接先 get 并跟随 nextAction。get 不返回 useId；leaseStatus=none 时 pending 读回和缺失预检先按 nextAction 无租约处理，直到 ready 或需租约的 BOOT/发送动作才 resume --recover-own。recoverable_own 用它恢复同一租约；仅成功验证或恢复后使用返回的 useId。ownership_unproven 和 conflict 均保留原状态；不得猜测“另一个 coordinator”或从账本取 useId。
- pending 先对账同一 message id 和 iteration。读工具可用时，即使发送工具缺失也读取既有 pending；没有读取能力时记录具体观察阻塞。idle、completed、空页和超时都不是无回复证据；不重发、不换 Chat、不清 pending。
- 所有有租约的状态变更都带本任务已验证的 --use-id。新消息先成功预留并确认身份；发送后分别确认 host 接受、用户消息送达和助手回复。
- 新 BOOT 只能用 prepare-boot。私有 messageFile 是 JSON；只在内存中读取并发送 body 字段，不输出材料或 token。发送不确定时先对账；只有证明发送工具从未调用且重新预检，才能恢复同一预留。
- BOOT 回复后必须实际调用 workspace_info 并确认目标 workspace 才可进入 ready。迁移使用同一 Chat 和绑定；源 pending 先对账。已完成 BOOT 后不要重复发送。
- 每个新业务 INIT、Chat 轮换后及 workspace 迁移后，都用 prepare-init 初始化 ChatGPT mem。ChatGPT 首先调用 memory_start_task；按需 memory_search、codewiki_*、只读 gitea_*；C2C 八个只读工具是当前工作区的最终依据。未经另行授权，不调用记忆或 Gitea 写接口。
- INIT/ANALYSIS 遗漏 REVIEW_HEAD 的可接受情形只确认真实传输回执，再按 Skill 发送同 HEAD 的 ANALYSIS 澄清；错误非空 HEAD 不可忽略。EXECUTED 审核必须回显精确 HEAD。
- C2C 回执、宿主读回、同任务租约恢复、迁移握手及固定池安全轮换属于本任务的内部恢复。不得修改其他任务的租约/pending，也不因此获得发布、部署、重启、凭据或清理权限。
- C2C 阻塞不会自动授权本地完整分析；只能交错执行用户已授权、明确独立且不依赖待回回复的步骤。结束时确认本任务无 pending、租约已释放、Chat 池未扩容，并检查其他绑定未被本任务改变。

## 文档维护

修改 C2C 行为时同步 Skill、docs/protocol.md、docs/host-control.md 与中英文 README。Skill 是可执行操作说明；协议文档定义状态和字段；README 只保留概览。源 Skill 与安装 Skill 除 checkout 路径替换外必须一致。
