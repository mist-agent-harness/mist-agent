# 插件协议 v0 验收清单

规范来源：[插件协议 v0 RFC](../docs/design/plugin-protocol-v0.md)。本清单先判协议形状，
不声称具体实现已经通过。实现落地时，每项必须成为确定性自动测试；测试违反约束后没有
明确红灯的条目，不得勾选。

每条测试记录四件事：fixture、动作、确定性断言、失败时的 reason code。含敏感值的
fixture 统一使用唯一标记 `SECRET_SHOULD_NEVER_APPEAR`，并扫描配置快照、日志、事件和
错误输出。

## A. Manifest 与兼容性

- [ ] **PV0-A01 合法 manifest 可进入 prepare**：四类插件各一份最小合法 fixture；校验后
  状态为 discovered/validated，尚未出现在能力目录。
- [ ] **PV0-A02 未知 schema fail-closed**：把 `manifestSchemaVersion` 改为 99；插件代码
  未加载、无资源注册，返回 `HOST_INCOMPATIBLE`。
- [ ] **PV0-A03 requiresMist 不可猜**：分别使用不匹配范围和不可解析字符串；两者均在
  加载代码前返回 `HOST_INCOMPATIBLE`。
- [ ] **PV0-A04 路径与枚举封口**：entrypoint 逃出插件根、未知 kind、未知 effect、重复
  capability id 分别返回 `MANIFEST_INVALID`，且无部分注册。
- [ ] **PV0-A05 缺要求不降级装**：删除 required env、配置或 credential ref；返回
  `REQUIREMENT_MISSING`。optional 缺失则可继续，但 readiness 明列缺失 scope。
- [ ] **PV0-A06 manifest 无需执行代码**：插件 entrypoint 顶层放置会抛错的探针；校验
  非法 `mist-plugin.json` 时探针计数为零，证明宿主在 import 前完成拒装。
- [ ] **PV0-A07 停用是真卸载**：enabled 从 true 切到 false 后完整经过 dispose，能力与
  资源不可达但设置仍在；重新启用时重新 validate/prepare/activate，不复用旧 handle。

## B. 权限、secret 与工具翻译

- [ ] **PV0-B01 字面量权限真收窄**：授权 `terminal_send.text=["/new"]`；发送 `/new`
  通过，发送 `/reset` 在执行前返回 `PERMISSION_DENIED`，执行器调用次数不增加。
- [ ] **PV0-B02 空数组不是通配**：operations 或 literals 为空时调用任意值均被拒绝。
- [ ] **PV0-B03 effect 不可降级**：插件把已登记 irreversible 操作声明成 read；manifest
  校验返回 `MANIFEST_INVALID`，不能以插件声明覆盖宿主能力契约。
- [ ] **PV0-B04 secret 全面不落字**：将唯一标记放入 secret env 和凭证值，覆盖成功、
  prepare 失败、运行时失败、dispose 失败四条路径；配置快照、日志、事件、错误文本均不含标记。
- [ ] **PV0-B05 翻译不扩权**：同一 tool capability 分别经 Claude SDK 和 pi 适配器翻译；
  输出仍带原 capability/plugin id、effect、operations 与 literals，未授权操作不可达。
- [ ] **PV0-B06 MCP 经 host 收编**：MCP server 暴露声明外工具；该工具不进入住户工具集，
  主 agent 精简集和 subagent 任务集只包含各自策略交集。

## C. 事务注册、隔离与注销

- [ ] **PV0-C01 prepare 不提前公开**：prepare 注册三个资源但未 activate；路由、能力目录
  和绑定接口均查不到它们。
- [ ] **PV0-C02 部分注册失败全回滚**：第三个资源注册抛错；前两个 handle 按逆序各撤销
  一次，插件返回 `PREPARE_FAILED`，能力目录为空。
- [ ] **PV0-C03 activate 失败全回滚**：prepare 成功、activate 抛错；所有资源撤销，
  rollback 被调用，返回 `ACTIVATE_FAILED`，没有半 active 状态。
- [ ] **PV0-C04 成功提交原子可见**：activate 成功前目录为零，提交后整批资源同时可见，
  不允许观察到子集。
- [ ] **PV0-C05 dispose 幂等**：同一 active 插件连续 dispose 两次；每个资源最多实际撤销
  一次，两次返回同一终态，无异常、无新资源。
- [ ] **PV0-C06 注销先断路**：制造一个在途调用后发起卸载；新调用立即拒绝，待在途调用
  结束或取消后逆序清理，卸载后所有路由、监听器、定时器和出站连接不可达。
- [ ] **PV0-C07 清理失败 fail-closed**：让一个 handle.revoke 失败；返回
  `DISPOSE_INCOMPLETE`，状态为 quarantined，资源 id 留在隔离记录，但任何住户都不能再调用。
- [ ] **PV0-C08 单插件故障不拖地基**：插件运行时同步抛错、异步拒绝、超时各一次；当前
  调用返回 `PLUGIN_RUNTIME_FAILED`，另一插件、住户存储和 boot-time 不变量仍可读写。
- [ ] **PV0-C09 不自动重试风暴**：失败插件在无显式操作时不再次 prepare/activate/call；
  计数器在观察窗内保持不变。

## D. 绑定、角色与凭证类型

- [ ] **PV0-D01 绑定键不串房**：两个 resident 的同名 `primary` 车道绑定不同适配器；
  并发 dispatch 各命中自己的 adapter/credential ref，互不泄漏。
- [ ] **PV0-D02 角色与车道正交**：main 和 subagent 使用同一车道时可走同一绑定，但 main
  获得住户记忆/精简工具集，subagent 无住户记忆且只获任务工具集。
- [ ] **PV0-D03 subagent 继承与换道**：未指定 lane 时继承请求车道；显式换到 coding 时
  重新校验绑定、权限和工具策略，缺任一项即在 dispatch 前失败。
- [ ] **PV0-D04 Claude OAuth 专属约束**：`claude_oauth → Claude SDK` 绑定通过；同一 ref
  绑定 pi 返回 `CREDENTIAL_TYPE_MISMATCH`，旧绑定不变、凭证不被读取。
- [ ] **PV0-D05 其他凭证按声明匹配**：codex_oauth、grok_oauth、api_key 只要在适配器
  accepts 内即可绑定；不在列表时返回 `CREDENTIAL_TYPE_MISMATCH`。
- [ ] **PV0-D06 Claude SDK 网关形状**：使用 baseUrl + tokenCredentialRef 可建立适配器，
  请求只在执行边界解析 token；配置、绑定与诊断中只有 ref id，没有 token 值。
- [ ] **PV0-D07 不制造悬空引用**：删除被绑定适配器或凭证时，宿主列出依赖并拒绝直接删；
  解除或迁移绑定后才能删除。
- [ ] **PV0-D08 错绑定不覆盖好绑定**：对现有 ready 车道提交无效新绑定；持久化失败后旧绑定
  仍可 dispatch，verified scope 不变。

## E. 升级、迁移与回滚

- [ ] **PV0-E01 成功升级原子切换**：v1 产生配置和绑定，v2 在副本上 migrate、validate、
  prepare、activate；提交前仍命中 v1，提交后整批命中 v2，再卸载 v1。
- [ ] **PV0-E02 迁移抛错回到 v1**：v1 → v2 的 migrate 抛错；返回 `MIGRATION_FAILED`，
  v1 插件、原配置、原绑定和原 verified scope 仍 ready。
- [ ] **PV0-E03 坏目标 schema 回到 v1**：migrate 返回不符合 v2 schema 的配置；结果同
  E02，不能留下被改写的旧配置。
- [ ] **PV0-E04 v2 激活失败回到 v1**：迁移与 prepare 成功、activate 失败；新版本资源
  全撤销，v1 恢复 ready，返回 `ACTIVATE_FAILED`。
- [ ] **PV0-E05 缺迁移路径拒绝升级**：config schema 改变但插件无对应 migrate；返回
  `MIGRATION_FAILED`，不尝试猜字段或原地升级。
- [ ] **PV0-E06 迁移不接触 secret 值**：migrate 输入只有配置副本与 credential refs；
  用探针凭证库证明迁移函数没有读取凭证值的调用权限。

## F. Readiness、投影与闭环

- [ ] **PV0-F01 readiness 有 scope**：ready/degraded/blocked/quarantined 每种 fixture 都
  返回 resident、lane、operations 和验证时间；换住户或车道后不能沿用旧 ready。
- [ ] **PV0-F02 原因码稳定可判**：A–E 每条失败路径只以 RFC 第 8 节 reason code 之一
  作为机器判决，附加文本变化不影响断言。
- [ ] **PV0-F03 每条约束都有红格**：对 manifest、权限、生命周期、绑定、迁移各做一次
  变异（删校验或扩大权限）；至少一个对应 PV0 条目必须由绿变红，否则协议验收不完整。
- [ ] **PV0-F04 boot-time 不变量不可卸载**：伪插件尝试覆盖权限闸或事件留史 provider；
  安装在 validate 阶段被拒，现有不变量仍可用。
- [ ] **PV0-F05 壳共享魂私有**：插件包、manifest、配置导出和诊断中扫描住户人格、记忆、
  聊天 fixture 标记；均不得出现，插件只能经受控 capability 在当前 scope 临时访问。

## 完成定义

协议实现完成必须同时满足：A–F 全部自动化并全绿；至少执行一次 F03 变异验证；
`npm run lint && npm run typecheck && npm test && npm run acceptance:strict` 全绿；评审能从
每个 RFC 约束直接指到一个 PV0 id，并从每个 PV0 id 指回唯一规范段落。
