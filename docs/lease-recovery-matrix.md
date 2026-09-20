# 恢复契约问题与验证矩阵

状态层决定动作，Skill 执行；下表不是另一套恢复算法。具体状态见 protocol，完整命令见 Skill。

| 编号 / 原反例 | 预期动作 / 禁止动作 | 源码与自动测试 | 真实证据 |
| --- | --- | --- | --- |
| L1 未传 use-id 被断言为他人占用 | 分类 own/recoverable_own/ownership_unproven/conflict；不得猜测 owner | state.ts classifyTaskLease；lease-continuation 的 CLI get/resume/host-control 测试 | 本任务 get 无 id 后 recoverable_own，正式恢复同一租约 |
| L2 阻塞输出泄露 use-id | 普通 get 和未验证 resume 不返回能力 | cli/index.ts；CLI 三入口不泄露测试 | 本任务普通 get 不含 use-id |
| L3 输出丢失导致租约失联 | 私有准备记录先写；中断后恢复同一 use-id | continuation.ts、resumeTaskSession；after_record/after_ledger/before_output 三处注入 | 真正省略原 use-id 后恢复；中断分支仅隔离模拟 |
| L4 文件缺失、损坏或公开权限 | 保留账本，报告证据不足；不得从账本补抄凭据 | lease-continuation 缺失/损坏/五字段冲突/ACL/硬链接测试 | 未破坏真实文件 |
| L5 workspace/Chat 变化丢失续接入口 | 按 task 定位；精确比对，轮换提交后刷新；中断只认唯一历史 | pool-rotation oldest safe Chat 测试；source workspace pending CLI 测试 | 本次沿用健康 Chat，不制造真实迁移 |
| L6 finish 后旧记录复活租约 | 先释放账本，再标记 released；旧 id 拒绝 | lease-continuation known own lease 测试 | 最终释放结果见 acceptance 文档 |
| L7 旧安全字符串 workspace 被新格式误拒绝 | 复用既有 safe identifier 规则，仍须精确相等 | continuation.ts；session.test leases and releases | 自动兼容测试 |
| L8 文档把自动入口误写成仅恢复 | 按用户契约：无租约且允许获取时创建并持久化；有租约只恢复自身；不替换未证明租约 | lease-continuation automatic CLI continuation 两项测试 | EXECUTED 真实 PLAN 揭示文档冲突，按原用户方案修正 |
| L9 无租约时提前获取阻塞迁移/预检 | 共享 canAcquireContinuationLease 限定获取阶段；CLI 保留当前动作，状态锁内再次检查；已有私有租约恢复不受影响 | lease-continuation wrong workspace、missing/expired preflight、existing own lease、action matrix | iteration 21 的真实 PLAN 揭示反例；修复后 iteration 22 复核 |
| L10 已有自身租约恢复后直接提示不可执行的迁移 | 无 pending 时先 release_own_lease_before_workspace_switch；finish --bound-workspace 成功后重新 get 才 switch_workspace | lease-continuation existing own lease 覆盖直接迁移拒绝、错误凭据零写、正确释放后动作切换 | iteration 22 揭示邻接阶段缺口，补齐完整迁移前置链 |
| L11 迁移示例复用已释放的 source use-id | source release 后清空旧变量；target 无租约预检后获取新租约再 BOOT；中断续接只恢复 target 自身租约 | lease-migration-flow.test.ts 实际 CLI 跨 switch 完整链；Skill 模板断言 | iteration 23 的真实 PLAN 揭示；原 Chat 随后出现长度上限，最终 DONE 尚未取得 |
| R1 pending 加 workspace 不同 | 先 reconcile_source_pending，再迁移 | readback-recovery 与 migration-handshake CLI 测试 | 未修改真实源 pending |
| R2 缺 sender 被当作不能读 | 可读取已有 pending；禁止新发送 | readback-recovery 与 lease-continuation missing send tool 测试 | 正常 sender/read 工具均可用 |
| R3 预检过期覆盖已送达等待 | pending 优先，保留消息阶段 | readback-recovery expired preflight 测试 | INIT 晚到 PLAN 仍确认原请求 |
| R4 BOOT DONE 被当业务完成 | workspace_info/confirm-workspace 后才 ready；业务单独 INIT | boot-preparation、migration-handshake、readback-recovery | 本次复用既有健康 BOOT，不重复发送 |
| R5 缺 REVIEW_HEAD 与错误 HEAD 混淆 | 合法缺失仅关传输回执，另发 ANALYSIS；错误 HEAD 拒绝 | mem-init 与 migration-handshake 测试 | 本次只读问题不要求 REVIEW_HEAD |
| R6 弱 PLAN 永久 pending | 先确认合法回执，再独立 ANALYSIS | mem-init truthful analysis follow-up 测试 | 本次 PLAN 有源码依据，未触发补充 |
| R7 idle、空页、六分钟未回复被当失败 | 继续同请求读回，必要时只读浏览器；不重发 | readback-recovery 模拟时钟/浏览器/晚到回复测试 | 页面显示约5分54秒；宿主先遗漏，浏览器读到，随后宿主可见 |
| R8 新 generation 的观察或旧能力被复用 | 锁内身份、代次、epoch、pending、能力检查 | pool-rotation、boot-preparation、readback-recovery | 不在真实任务上伪造观察 |
| R9 回执命令遗漏租约 | 携带已验证自身 use-id；文件冲突拒绝且零写入 | readback-recovery CLI readback uses its verified lease flag | 本任务真实确认均使用自己的租约 |
| S1 claim/switch 一次性 token 文案 | 全部 prepare-boot；只发送私有 JSON.body | boot-preparation 实际 CLI；Skill 文档契约 | 健康绑定无需新 BOOT |
| S2 手写 INIT 绕过 mem | prepare-init，精确正文摘要和实际 mem 回显 | mem-init CLI；文档契约 | memory_start_task、memory_search、C2C read_file 已观察；DEGRADED 原因保留 |
| S3 阻塞默认放行本地完整分析 | 依赖门禁不放行；只允许独立、确定、已授权步骤交错 | shared recovery businessGate 断言；六类 Skill 路由指令检查 | 用户已有完整计划；真实 PLAN 后完成结果核实 |
| S4 示例不可执行或身份写死 | 真实 CLI 字段、动态 iteration/message、PowerShell parser | 文档契约、CLI 时序、PowerShell 语法检查 | 安装版内容一致性另验 |

自动测试结果、安装一致性和最终真实往返见 [验收记录](lease-continuation-acceptance.md)。文档检查仅证明指令存在；六类路由场景不是六个独立模型会话。实际池为 8 claimed + 7 retired 的既存状态，本轮不扩容或删除历史。
