# Skill 分析分工修复验收

本地基线：`2aa8ef8f9b26756a7000c09265f460015ce6c971`，`main`。
验收对象为基线之上的未提交修改，不是该提交已包含本轮修复。
未提交、推送或执行远端 CI；未重启 Router/Tunnel，未修改 CLI/MCP 实现。

## 自动检查与安装

- 完整回归：46 个文件、529 项测试通过。
- 后续例外边界文字与断言补充后：5 个相关测试文件、49 项通过。
- 类型检查、构建、Windows 安装冒烟通过；`git diff --check` 通过。
- 安装位置：`C:\Users\jack\.codex\skills\codex-with-chatgpt\SKILL.md`。
  源 Skill 保留 `__C2C_CHECKOUT__`；安装版仅替换该路径，逐字比较一致，UTF-8 无 BOM。
- 最终源 Skill SHA-256：`931B87A14F49C824125517597174C2218CA2B74D9A4A99140633A043CB8654D0`。
- 最终测试文件 SHA-256：`AB2B4674D93013D44F78D7A7461976AC8E0A5CA01735F68E6A91317AC617B40A`。

这些检查由 Codex 执行；文档断言证明指令存在，不证明模型始终遵循或节省了具体额度。

## 当前任务的真实 Chat 循环

- task：`01a07256-fb2e-7b03-a618-530c5741c694`。
- workspace：`d0422e65fbc9`。
- 原绑定 Chat：`6a9b189a-5914-83ea-aa13-14662cb17d0e`，generation 1；全程同一 Chat。
- iteration 4 INIT：`c2c_msg_7b18bc12-e187-4324-af94-7103c7566a8f`。
  ChatGPT 返回实质 PLAN，定位旧 Skill 的时序缺口和测试落点，并建议增加顺序断言。
  回复列出 `workspace_info`、`git_status`、`read_file`、`search_workspace`，以及读取的
  Skill、install-readiness、host contract、delivery protocol、MCP integration 测试。
- iteration 5 EXECUTED：`c2c_msg_3ca934ef-9114-49d1-8cc6-83e0d0af35ea`。
  ChatGPT 读取新版文件，返回六类场景判断并指出简单操作例外可能被机械大改误用。
  Codex 核对用户实际授权后，补充“不需要探索、设计或诊断”和跨文件影响未明的边界。
- iteration 6 EXECUTED：`c2c_msg_c7f09bbf-f3dd-4070-a936-438dfb883cb4`。
  回复 `1f7e3b61-a45f-4df8-9c7e-0663829db022` 返回 DONE，正确回显 task、workspace、iteration、
  message 和完整 REVIEW_HEAD；明确读取当前未提交文件，而非仅基线提交。
- 每条消息均完成 accepted、原用户消息读回、匹配回复确认。
  最终 `verificationState=ready`、`channelState=ready`、无 pending、`lastState=DONE`。
  `session finish` 成功释放本任务租约，`activeUse=null`。

宿主曾短暂显示 idle 而尚未返回回复；保留原请求继续读回后取得 PLAN，没有重发。
期间只实施已有用户完整方案，未把观察缺口当作新的分析授权。
工具读取清单来自 ChatGPT 的带源码依据回复；宿主 read_thread 没有提供逐次 MCP 调用原始日志，
因此不将该清单表述为独立工具调用审计。Codex 对相关源码和测试落点做了必要核实。

## 六类场景结果

| 场景 | ChatGPT 根据新版 Skill 给出的首动作 |
| --- | --- |
| 陌生模块 | ready 后 INIT，先由 ChatGPT 探索并产出 PLAN |
| 复杂故障 | ChatGPT 根因分析和测试设计，Codex 按 PLAN 执行 |
| 完整用户方案 | 只补必要代码定位和缺口，不强制重新规划 |
| 错字修改 | 无需探索、设计或诊断时直接执行 |
| 纯复核 | 保持复核范围，遵循 REVIEW_HEAD 和回执合同 |
| 通道不可用 | 保留绑定和 pending，报告阻塞，只继续独立授权的明确工作 |

六类场景为同一真实 Chat 的分工判断验收，不是六个独立任务执行实验。
真实完成的是当前任务的源码分析、PLAN、执行反馈、修正与 DONE 循环。
没有测量或宣称具体额度节省比例。
