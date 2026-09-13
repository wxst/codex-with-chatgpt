# Worktree 迁移握手验证记录

日期：2026-09-11。验证对象为 main `7c2a35e1e6eb847e77e21d2622c8daf3ddc0983f` 上的未提交修改。

## 实现与自动检查

- 迁移保存来源回执、前后 workspace/generation、assignmentEpoch 和独立握手 ID。
- `host-control --result migration-read-ok --observation-file` 仅授予一次当前 generation 的 BOOT 预检资格；普通 INIT 不获授权。
- 原回执不冒充新 workspace 回执。新 BOOT 回复与实际 workspace_info 确认后才完成握手。
- 旧格式恢复要求唯一历史链及精确回执，不改变 Chat/generation；不完整或歧义证据失败关闭。
- 新增 25 项迁移测试通过，包括实际 CLI 原错误复现、完整预检/BOOT/确认、错误证据零写入、旧格式和连续迁移、并发单赢家、历史缺失/重复以及旧 DONE 不可验证新 workspace。
- Router MCP 测试改为走迁移预检，并实际验证旧 token 拒绝及新 workspace_info。
- 最终完整回归：47 文件，46 通过、1 失败；590 项中 589 通过、1 失败。
- 唯一失败为 `tests/legacy-state-guard.test.ts:1222` 的 512 文件 ACL 检查触及其自身 20 秒超时；相关源码和测试均未修改。单独相关运行也复现超时，未通过提高门槛掩盖，根因未判定。
- 类型检查、构建、Windows 安装冒烟、差异检查通过。安装 Skill 与源文件仅 checkout 路径替换不同。

## 真实迁移 BOOT

- 原任务：`01a07295-ab0f-7953-a8b8-fe82e0a93ec1`（完成工单 #41 v4.0 实现交付），以自身身份执行。
- 原 Chat：`6a9b189e-251c-83ea-8249-0d27be28b5f0`，保持 generation 3、assignmentEpoch 2。
- 来源 workspace：`6062e514e469`；目标：`2317f4a0bdd9`。
- 原 iteration 20 / PLAN / `c2c_msg_1bb07157-6a97-476b-8fc6-a94b53e9aa3d` 完整保存在握手 receipt 中；没有 REVIEW_HEAD，不把普通 HEAD 冒充它。
- 新 BOOT：iteration 21 / `c2c_msg_4deeb89c-ce20-42fa-a02a-4bbb2c27bdcf`。
- 新 BOOT 回复：`5a6a2649-20b9-47ee-8f3c-02037bca0c1e`，精确身份匹配，实际 workspace_info 返回目标 workspace、原 task、codex-memory-pro、master；状态 DONE。
- 账本握手 `c2c_migration_fa688168-894d-481c-9ed0-d5c0578815ea` 于 `2026-09-11T03:02:20.483Z` 完成，verificationState 已 ready。
- INIT 22：`c2c_msg_b19c181f-f572-4e40-895a-7875cf1ee44b`，同 Chat 返回 PLAN。
- EXECUTED 23：`c2c_msg_de8ea37b-097d-49e2-937b-26d00cece999`；最终回复 `9667c5ec-531c-4950-aa1b-287b8c580598` 回显精确身份并返回 DONE。
- 最终回复给出 `src/cli.mjs:1168` 的 hooks 分发与 1170–1174 行动态导入的三个 handler，实施任务独立读取现场源码核实一致。没有执行这些业务命令。
- 最终账本独立核实：iteration 23、lastState DONE、verificationState/channelState 均 ready、pendingMessageId 为 null、activeUse 为 null。原任务已正常释放自身租约。

## 证据与边界

宿主任务读取接口曾返回 completed/items=[]，随后显示 active 但无消息记录。用户提供的任务截图补齐事实：最初两次跨任务请求被原任务按其自身业务范围拒绝；用户随后直接要求“你配合执行一下C2C恢复验收”，原任务才开始执行。读取接口没有暴露这些拒绝回复，不能据此诊断执行引擎故障，也不能将观测缺口写成“没有执行”。随后直接 Chat 读回和账本共同证实真实恢复完成。

验收前账本副本保存在本机临时目录 `c2c-migration-before.json`。池仍为 10 个，entry ID 集合不变。并发任务 `019dcaff-7753-7791-bba2-bc6cab1bde1f` 在自己的 Chat 发送 EXECUTED `c2c_msg_b97bb4fb-69cc-4b49-8de7-ae79b38ff0ad`，其回执正常变化而绑定/generation 未变；不能声称整个账本逐字不变。其余任务与池项未见变化。

本轮不新增任务或 agent、不重启服务、不清理其他任务、不提交或推送。真实迁移死锁已解除，同 Chat 的 BOOT、workspace_info、INIT/PLAN、代码读取、EXECUTED/DONE 和租约释放均已核实，真实恢复验收通过；完整测试仍有上述超时失败，不能宣称全部自动检查通过。
