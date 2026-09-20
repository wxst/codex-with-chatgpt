# 租约续接与统一 Skill 验收

基线：`main@ac97f29bc721308fad59992558b2daaeae35ef69`，2026-09-20。

## 自动验证

- `tests/lease-continuation.test.ts`：私有续接、三处中断、CLI 输出脱敏、真实宿主身份、源 workspace pending、冲突与文件权限。
- `tests/pool-rotation.test.ts`：轮换后刷新自身续接记录；模拟账本提交后记录未更新，以唯一交接历史恢复；缺少历史拒绝且不改账本。
- `tests/readback-recovery.test.ts`：读回命令使用自身租约参数，拒绝与观察文件冲突的凭据；晚到回复、分页、观察故障与业务门禁。
- `tests/session.test.ts`：兼容既有安全字符串 workspace ID，不能把合法旧标识限制为新生成的 12 位十六进制形式。
- 文档契约测试只验证指令和示例存在，不证明模型真实遵循全部分支。
- 最终完整回归：53 个文件、725 项全部通过，耗时 349.09 秒；包含新增跨迁移实际 CLI 测试。相关租约/迁移/Skill 套件 67 项和后续 16 项分别通过。类型检查、构建、Windows 安装冒烟、14 段 PowerShell 示例语法及 Skill 格式校验通过。最终日志为本机 `c2c-complete-full.log`。

## 当前任务真实证据

- 实施任务：`01a07256-fb2e-7b03-a618-530c5741c694`。
- workspace：`d0422e65fbc9`；Chat：`6a9b187e-39b8-83ea-bfef-fb7f992e6540`；generation 3，assignmentEpoch 6。
- 复用已有健康 BOOT/workspace 确认，没有重复 BOOT、迁移或创建 Chat。
- 将本任务已知租约登记为私有续接记录；后续省略 use-id，get 返回 recoverable_own；resume --recover-own 返回同一租约。没有读取或借用其他任务租约。
- INIT iteration 19：`c2c_msg_9b387280-09a9-42a3-8d29-092c5a4b4acc`；正文摘要 `cf7857d8c9f28c05b799794dee5f0a83faed29302be7d973887ef36867885ba8`。
- INIT 只发送一次，实际用户正文读回摘要匹配，PLAN 身份匹配并已确认。页面显示思考约 5 分 54 秒；宿主一度 idle 但遗漏回复，浏览器只读观察取得真实回复，后续宿主也能读取该 PLAN。
- 工具面板实际显示 memory_start_task 成功、memory_search 调用和 C2C read_file 源码读取。回复为 MEMORY_STATUS DEGRADED：embedding 健康检查不可用；不宣称 mem 完全健康。
- 脱敏工具面板、实际正文、读回观察与基线保存在本机临时目录 `c2c-lease-*` 证据文件；不将凭据、私有材料或完整 Chat 历史入库。
- EXECUTED iteration 20 的匹配 PLAN 发现 Skill 将 recover-own 错写为仅恢复。用户批准的契约明确允许无现有租约时安全获取，因此修正文档而非删除程序的已授权能力；新增 CLI 测试覆盖安全获取、释放后新 id、未决请求拒绝获取。该 PLAN 已完成真实回执确认，没有保留成永久 pending。
- iteration 21 的 PLAN 发现自动获取跳过 nextAction，可在迁移前提前领取旧绑定租约。增加共享获取阶段判断，并在 CLI 与锁内校验；错误 workspace、缺失/过期预检均零写拒绝。
- iteration 22 确认上述获取检查，但发现恢复已有租约后还需释放才能迁移。增加 release_own_lease_before_workspace_switch；使用自身凭据执行 finish --bound-workspace，再 get 得到 switch_workspace。相关 CLI 测试同时证明直接迁移仍拒绝、错误凭据释放零写、源 pending 仍先对账。
- iteration 23：`c2c_msg_48bc4f12-21c9-4919-af7e-cc19a2b034c2`。宿主仍显示 active 时，精确网页已有匹配 PLAN。浏览器原助手正文已保存并通过普通 confirm-reply 确认；网页错误提示不混入助手正文。
- 该 PLAN 确认程序获取/恢复/释放/迁移边界，但指出迁移示例仍用已释放的 source id。已修正为 source release → switch → target 无租约预检 → 新 target lease → BOOT，并新增 lease-migration-flow.test.ts 实际 CLI 全链测试；旧 source id 在 target 被拒绝，16 项相关测试通过。
- 原 Chat 同时明确显示“你已达到此对话的长度上限”。未伪造 DONE，也未为已知不可继续的 Chat 预留新消息。最终业务验收未完成；用户随后明确要求“直接发布部署，不用验收”，取消本轮剩余真实验收的发布前置条件。
- 已通过正式 finish 释放本任务租约。真实账本为 ready、无 pending、activeUse=false、私有记录 released，最后回执是 iteration 23 PLAN。其他 11 个任务的完整绑定摘要全部不变，池成员不变。脱敏最终状态保存在本机 `c2c-lease-final.json`。

## 已知边界

- 真实基线为 8 个 claimed、7 个 retired，总 15 条池记录；这与固定十个的配置约定存在既存差异。本次不扩容、不删除历史凑数。
- 最终释放后的比对，池成员不变，其他 11 个绑定的完整记录摘要均不变。
- 故障注入、并发、损坏文件和旧身份拒绝是隔离测试证据，不宣称在用户真实 Chat 上制造了这些故障。
- 缺少可信私有记录的遗留租约仍需要归属证据；不会伪称其他协调者占用，也不会自动强占。
- 安装 Skill 与源文件在替换 checkout 路径后完全一致。按用户最新授权直接提交、正常推送并刷新本地 Router/Bridge，不再轮换 Chat 或继续真实验收；Tunnel 不启动或重启。真实 DONE 未取得这一事实不因发布授权而改变。
