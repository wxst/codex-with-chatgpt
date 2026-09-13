# 固定 Chat 池恢复验收记录

日期：2026-09-11（Asia/Taipei）。基线 HEAD：`7c2a35e1e6eb847e77e21d2622c8daf3ddc0983f`，验证对象为其上的未提交修改。

## 自动检查与安装

- 相关测试：109 项通过。
- 完整测试：46 个文件、565 项通过。
- 类型检查、构建、Windows 安装冒烟、`git diff --check` 通过。
- 安装版 Skill 与源文件仅 checkout 占位符替换不同，逐字比较一致。
- 自动测试覆盖固定十项库存、LRU、跳过忙碌项、失效绑定原子恢复、并发单赢家、失败零写入、旧能力失效、新 owner BOOT 与严格 notLoaded 证据。

## 真实宿主往返

- 当前任务：`01a07256-fb2e-7b03-a618-530c5741c694`。
- Workspace：`d0422e65fbc9`。
- 同一 Chat：`6a9b189a-5914-83ea-aa13-14662cb17d0e`。
- 修正 ChatGPT 宿主调用，省略 Codex 的 `hostId` 后原绑定恢复使用；没有新建任务或 Chat。
- INIT 8：`c2c_msg_65382908-2fe2-470a-bab0-11af1bfa8a8f`。ChatGPT 通过 MCP 读取代码，返回实质 PLAN；提出的三个缺口已修复。
- EXECUTED 9：`c2c_msg_f7fda04d-ac39-44fa-8778-067cc60ef020`。
- 最终回复：`58b0aef8-55eb-4aa5-aa25-a55be085ff9c`，所在轮次 `c3a46613-6ec2-4f26-aaaf-20e3f59509af`。
- 最终回复回显精确 task、workspace、iteration、message ID 与 REVIEW_HEAD，状态 DONE；实际读取 workspace_info、git_status、git_diff、test_status、execution_summary 与相关源码。workspace_info 返回当前任务、当前 workspace、分支 main。
- 请求先被宿主接受，随后通过精确 Chat 读回确认送达，再确认 DONE；等待期间没有重发。
- 最终账本：verificationState/channelState 均 ready，lastState DONE，无 pendingMessageId，activeUse 为 null。
- 最终 EXECUTED 前后账本比较：活动池均为 10 个且 entry ID 集合相同；其余 13 个 task 记录逐字序列化比较一致，包括绑定和回执。
- 比较基线保存在本机临时目录 `c2c-fixed-pool-before-final.json`；完整请求和回复保留在上述 Chat，当前回执保留在 assignment ledger。

## 验证边界

本轮真实验证的是原 Chat 的路由恢复及 INIT → PLAN → EXECUTED → DONE。恢复后绑定健康，按照项目规则继续使用，没有为了测试强制轮换。因此本轮没有新增真实 pool_reclaimed 或新 owner BOOT；生产池轮换的完整真实验收尚未完成，不能用自动测试替代。固定池原子轮换、历史归档及新 owner BOOT 当前有源码和自动测试证据。

没有重启 Router/Tunnel，没有清理其他任务状态，没有提交或推送。
