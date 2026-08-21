# 插件协议 v0 验收清单

规范来源：[插件协议 v0 RFC](../docs/design/plugin-protocol-v0.md)。本清单先判协议形状，
不声称具体实现已经通过。实现落地时，每项必须成为确定性自动测试；测试违反约束后没有
明确红灯的条目，不得勾选。

F 系列运行态口径的增量见 [runtime-readiness.md](../docs/design/runtime-readiness.md)，
对应实测位于 `tests/plugin-runtime-readiness.test.ts` 与
`tests/pv0/pv0-f-readiness-semantics.test.ts`。

每条测试记录四件事：fixture、动作、确定性断言、失败时的 reason code。含敏感值的
fixture 统一使用唯一标记 `SECRET_SHOULD_NEVER_APPEAR`，并扫描配置快照、日志、事件和
错误输出；凡插件产物会进入模型，还要扫描带来源标记的住户上下文快照。

## A. Manifest 与兼容性

- [ ] **[PV0-A01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 合法 manifest 可进入 prepare**：四类插件各一份最小合法 fixture；校验后
  状态为 discovered/validated，尚未出现在能力目录。
- [ ] **[PV0-A02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 未知 schema fail-closed**：把 `manifestSchemaVersion` 改为 99；插件代码
  未加载、无资源注册，返回 `HOST_INCOMPATIBLE`。
- [ ] **[PV0-A03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) requiresMist 不可猜**：分别使用不匹配范围和不可解析字符串；两者均在
  加载代码前返回 `HOST_INCOMPATIBLE`。
- [ ] **[PV0-A04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 路径与枚举封口**：entrypoint 或 context injection source 逃出插件根、
  未知 kind/effect/injection mode、重复 capability/context injection manifest `id` 分别返回
  `MANIFEST_INVALID`，且无部分注册。
- [ ] **[PV0-A05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 缺要求不降级装**：删除 required env、配置或 credential ref；返回
  `REQUIREMENT_MISSING`。optional 缺失则可继续，但 readiness 明列缺失 scope。
- [ ] **[PV0-A06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) manifest 无需执行代码**：插件 entrypoint 顶层放置会抛错的探针；校验
  非法 `mist-plugin.json` 时探针计数为零，证明宿主在 import 前完成拒装。
- [ ] **[PV0-A07](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 停用是真卸载**：enabled 从 true 切到 false 后完整经过 dispose，能力与
  资源不可达但设置仍在；重新启用时重新 validate/prepare/activate，不复用旧 handle。
- [ ] **[PV0-A08](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) plugin id 封口**：大写、空白、路径分隔符和 `../evil` 均返回
  `MANIFEST_INVALID` 且不加载代码；普通安装复用现役 id 返回 `PLUGIN_ID_CONFLICT`，
  只有显式 upgrade 能携同 id 进入 E 区事务。
- [ ] **[PV0-A09](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) env 绑定形状不可混用**：逐一测试 secret×value、secret×secretRef、
  plain×value、plain×secretRef；只有中间两种匹配组合中的 secret×secretRef 与
  plain×value 通过，错配返回 `CONFIG_INVALID`，明文 secret 不进入配置快照。
- [ ] **[PV0-A10](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) env 只经 context 交付**：manifest 声明 plain `A`、secret `B`、可选未绑定
  `C`；插件 prepare 时记录 `context.env` 的键集合，并另设 `process.env.D` 探针。断言
  `context.env` 恰为 `{A, B}`（`B` 为已解析值）、不含 `C`/`D`；配置快照、日志与事件中
  `B` 的值不出现（`SECRET_SHOULD_NEVER_APPEAR`）；宿主向插件交付未声明名字或漏交
  `required` 项时本条变红，后者返回 `REQUIREMENT_MISSING`。

## B. 权限、secret 与工具翻译

- [ ] **[PV0-B01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 字面量权限真收窄**：授权 `terminal_send.text=["/new"]`；发送 `/new`
  通过，发送 `/reset` 在执行前返回 `PERMISSION_DENIED`，执行器调用次数不增加；插件为
  宿主契约未登记为可收窄参数的字段自造 literal 限制时，manifest 返回 `MANIFEST_INVALID`。
- [ ] **[PV0-B02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 空数组不是通配**：operations 或 literals 为空时调用任意值均被拒绝。
- [ ] **[PV0-B03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) effect 不可降级**：插件把已登记 irreversible 操作声明成 read；manifest
  校验返回 `MANIFEST_INVALID`，不能以插件声明覆盖宿主能力契约。
- [ ] **[PV0-B04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) secret 全面不落字**：将唯一标记放入 secret env 和凭证值，覆盖成功、
  prepare 失败、运行时失败、dispose 失败四条路径；配置快照、日志、事件、错误文本和带
  来源标记的住户上下文快照均不含标记。
- [ ] **[PV0-B05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s6) 翻译不扩权**：同一 tool capability 分别经 Claude SDK 和 pi 适配器翻译；
  输出仍带原 capability/plugin id、effect、operations 与 literals，未授权操作不可达。
- [ ] **[PV0-B06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s6) MCP 经 host 收编**：MCP server 暴露声明外工具；该工具不进入住户工具集，
  主 agent 精简集和 subagent 任务集只包含各自策略交集。
- [ ] **[PV0-B07](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s6) 翻译输出是闭集**：坏适配器在完整保留 metadata 的同时额外暴露
  `run_arbitrary`，或静默漏掉一个已授权操作；前者因无源工具、后者因映射不完整而使该
  capability 非 ready，输出集必须与 verified scope 的源操作逐项对应。
- [ ] **[PV0-B08](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s8) 完整用户输入不进诊断**：使用独立随机长句作为住户原话探针，覆盖成功、
  prepare 失败、运行时失败、dispose 失败四条路径；日志、事件、错误文本及插件来源的诊断
  注入段均不得含完整探针。原始住户消息本身不属于插件泄漏，断言必须按来源区分。
- [ ] **[PV0-B09](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s6) lazy 不预注入 schema**：声明 lazy capability，active 后住户目录只含 id、
  plugin 来源和单行 description，不含完整 operations schema；按需取回后可以调用，且取回前后
  权限结果一致。把 lazy 当 eager 全量铺入上下文时本条变红。
- [ ] **[PV0-B10](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 注入正文安装前可审计**：声明 resident/session 两种 context injection；
  模型上下文中的正文逐字来自包内 source，并带 plugin id、注入 manifest `id`、路径和 scope。换包版本后
  diff 可见，session 注入不跨会话残留。
- [ ] **[PV0-B11](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) 未声明或漂移的注入显式拒绝**：MCP server 下发 manifest 未声明的
  instructions，或把已声明正文改一个字；文本不进入住户上下文，返回
  `CONTEXT_INJECTION_MISMATCH`，capability 非 ready，住户能看见拒绝原因而非静默截断。
- [ ] **[PV0-B12](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s8) secret 不经插件产物进入模型**：恶意 fixture 分别从工具返回值和已声明
  context injection 回显执行边界解析过的 secret 标记；两条都在装入模型上下文前返回
  `SENSITIVE_OUTPUT_BLOCKED`，上下文、后续摘要输入和记忆候选中均无该标记。
- [ ] **[PV0-B13](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 注入随停用与卸载撤下**：active 插件分别装入 resident/session 注入后，将
  `enabled` 切为 false 并完成 dispose；住户上下文快照、启动包及下一次会话重建输入均不含
  该 plugin id 的注入段。工具与资源已消失但守则仍留在 wakepack 时本条变红。
- [ ] **[PV0-B14](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s2) secret 不落 settings 通道**：把同一唯一标记分别作为 `secretRef` 解析值和
  凭证值下发，插件 active 后转储宿主写盘的 instance config 与全部配置快照；`settings` 及
  快照中均不出现该标记。宿主把解析后的 secret 或凭证值回写进 `settings`／配置快照时本条
  变红，键名叫 `token` 还是 `theme` 不改变判定。

## C. 事务注册、隔离与注销

- [ ] **[PV0-C01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) prepare 不提前公开**：prepare 注册三个资源但未 activate；路由、能力目录
  和绑定接口均查不到它们。
- [ ] **[PV0-C02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 部分注册失败全回滚**：第三个资源注册抛错；前两个 handle 按逆序各撤销
  一次，插件返回 `PREPARE_FAILED`，能力目录为空。
- [ ] **[PV0-C03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) activate 失败全回滚**：prepare 成功、activate 抛错；所有资源撤销，
  rollback 被调用，返回 `ACTIVATE_FAILED`，没有半 active 状态。
- [ ] **[PV0-C04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 成功提交原子可见**：activate 成功前目录为零，提交后整批资源同时可见，
  不允许观察到子集。
- [ ] **[PV0-C05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) dispose 幂等**：同一 active 插件连续 dispose 两次；每个资源最多实际撤销
  一次，两次返回同一终态，无异常、无新资源。
- [ ] **[PV0-C06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 注销先断路**：制造一个在途调用后发起卸载；新调用立即拒绝，待在途调用
  结束或取消后逆序清理，卸载后所有已登记或经宿主管理的路由、监听器、定时器和出站连接不可达。
- [ ] **[PV0-C07](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 清理失败 fail-closed**：让一个 handle.revoke 失败；返回
  `DISPOSE_INCOMPLETE`，状态为 quarantined，资源 id 留在隔离记录，但任何住户都不能再调用。
- [ ] **[PV0-C08](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s4) 单插件故障不拖地基**：插件运行时同步抛错、异步拒绝、超时各一次；当前
  调用返回 `PLUGIN_RUNTIME_FAILED`，另一插件、住户存储和 boot-time 不变量仍可读写。
- [ ] **[PV0-C09](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s4) 不自动重试风暴**：fixture 先执行一次
  会返回 `PLUGIN_RUNTIME_FAILED` 的失败 `call`；随后只用可控 fixture clock 或 scheduler tick 推进至少一个
  失败后的调度周期并排空队列。整个确定性观察窗内 prepare、activate、call 三类计数均不增加；不得使用
  真实 sleep，也不得为此定义生产 TTL。
- [ ] **[PV0-C10](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 生命周期中断可恢复**：分别在 ① activate 已创建资源但 active 终态写盘前、
  ② active 终态已写盘但 `PreparedPlugin.activate()` 尚未返回时、
  ③ dispose 已撤销部分资源时杀死宿主进程。重启后先执行操作日志协调且插件入口始终不可达：
  fixture 的三个资源必须是宿主子进程退出后仍存活、可由父进程独立枚举的外部副作用（例如
  fixture 目录内的锁文件/端口代理登记）；不能用随子进程一起消失的内存计数器冒充回收。
  宿主 `operationId`、装载模块的 `moduleRef` 与每个资源的稳定 recovery key 都要在首个
  副作用前落盘。重启协调只能调用
  `PluginModuleV0.recover(context)` 重建专用撤销器，不得重跑普通 prepare/activate：
  ① 按持久化注册日志回滚后停在 `blocked + ACTIVATE_FAILED`，保留 plugin id、operationId、
  `enabled: true` 的启用意图、配置与绑定，等待显式重试或停用；
  ② 已写盘的 active 记录改回 `blocked + ACTIVATE_FAILED`，与 ① 同终态、同样保留启用意图——
  协调**不得**调用 `PreparedPlugin.activate()` 补跑发布，也不得把该记录投影为 active/ready；
  发布步骤无幂等要求，补跑等于替住户按下重试。**同时断言资源真被回收**：三个资源均已
  activate 过，协调必须按注册逆序 `revoke` 全部资源并 `rollback`，撤销回执逐笔落盘，
  全部成功后记录才改写为 `blocked`；父进程探针在协调后为零，且 prepare/两个 activate 的
  调用计数在重启协调期间均不增加。跳过 revoke 直接改写状态位、
  或以「终态已写盘」为由把资源留在已提交状态，本条变红；
  ③ 从撤销回执继续逆序清理，失败则 quarantined。另加缺失/重复/漂移 recovery key、
  模块内容摘要与 `moduleRef` 不符、与 `recover(context)` 抛错五个分支：均返回
  `RECOVERY_HANDLE_UNAVAILABLE` 并 quarantined，
  外部残留和人工处理清单继续可枚举，不得写成 blocked/disposed。剩余资源 id 与 quarantined 记录跨重启仍可
  枚举，协调期间返回 `LIFECYCLE_RECOVERY_PENDING`，不得把任一孤儿中间态恢复成 ready 或假装
  从未安装。此处协调是启动时未完成 activate/dispose 日志的恢复，不是用户重试；协调后 blocked
  只能显式修复/重试重新走生命周期，或显式停用清理。
- [ ] **[PV0-C11](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 权威状态先于公开索引**：在 active 四元组原子提交前、提交后但公开前、公开后
  三个时点分别杀死宿主；每次重启后，可枚举入口、路由索引与工具目录都必须是已持久化
  `{active, config, bindings, verifiedScope}` 的子集。先持久化路由索引再写 active 记录时本条变红。
  本条与 C10 的主证据都由 Vitest 集成测试提供：测试启动真实宿主子进程，在指定时点将其杀死并
  重新拉起，再断言可枚举结果；进程内状态快照对比只能作辅证，不得替代 kill/restart，也不得
  用 mock 重启、清空内存态或临时脚本冒充。
- [ ] **[PV0-C12](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) quarantined 只能显式清理重试**：制造一次部分撤销失败，确认插件进入
  `quarantined` 且所有入口保持 fail-closed；无显式操作时不得再次调用清理。重复调用
  `dispose` 不是显式重试，必须幂等返回同一 `quarantined` 隔离态且不再次执行清理；只有宿主
  独立的显式清理重试（例如 `retryCleanup(pluginId)`）才能继续撤销。重试且全部剩余资源
  撤销成功时进入 `disposed`；重试再次失败时仍为 `quarantined`，剩余资源 id、reason code、
  操作记录和人工处理清单均保留，不得伪装成 `disposed` 或恢复为 `ready`。
- [ ] **[PV0-C13](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 两个 activate 顺序固定**：prepare 注册三个资源，每个 `ResourceDeclaration.activate()`
  记录调用序号并保持不可达探针为零。**两侧断言分主语**——宿主的持久化对插件不可观测，
  插件只能断言自己记得的提交集合：
  - 插件侧（`PreparedPlugin.activate()` 内部）：断言自己声明的三个资源均已收到宿主提交，
    否则拒绝发布；三个资源 activate 全部先于唯一一次 `PreparedPlugin.activate()`；
    发布前所有可达性探针为零，发布后探针为正。
  - 宿主侧（测试夹具，非插件）：断言 active 四元组写盘先于调用 `PreparedPlugin.activate()`。

  宿主先调 `PreparedPlugin.activate()` 再逐资源提交、或在任一资源 activate 失败后仍发布，
  本条变红，返回 `ACTIVATE_FAILED` 且全量 rollback。
- [ ] **[PV0-C14](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s3) 恢复凭据防模块漂移**：fixture 插件在 activate 已创建资源、active 终态
  写盘前被杀（同 C10 ①时点）；保持 plugin id 与声明版本字符串不变，原地改写模块内容后重启
  宿主。协调必须在调用 `recover` 之前重算模块内容摘要并与操作日志 `moduleRef` 比对：不符即
  返回 `RECOVERY_HANDLE_UNAVAILABLE` 并进入 `quarantined`，`recover`/`prepare`/两个 activate
  的调用计数在协调期间均为零，人工处理清单含期望与实际摘要且跨重启可枚举。仅凭声明版本
  字符串判定「同版本」并调用 `recover`，或摘要不符仍继续协调，本条变红。显式重装或升级
  路径不受本条限制，但不得由启动协调自动触发。

## D. 绑定、角色与凭证类型

- [ ] **[PV0-D01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 绑定键不串房**：两个 resident 的同名 `primary` 车道绑定不同适配器；
  并发 dispatch 各命中自己的 adapter/credential ref，互不泄漏。
- [ ] **[PV0-D02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 角色与车道正交**：main 和 subagent 使用同一车道时可走同一绑定，但 main
  获得住户记忆/精简工具集，subagent 无住户记忆且只获任务工具集。
- [ ] **[PV0-D03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) subagent 继承与换道**：未指定 lane 时继承请求车道；显式换到 coding 时
  重新校验绑定、权限和工具策略，缺任一项即在 dispatch 前失败。
- [ ] **[PV0-D04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) Claude OAuth 专属约束**：`claude_oauth → Claude SDK` 绑定通过；同一 ref
  绑定 pi 返回 `CREDENTIAL_TYPE_MISMATCH`，旧绑定不变、凭证不被读取。
- [ ] **[PV0-D05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 其他凭证按声明匹配**：codex_oauth、grok_oauth、api_key 只要在适配器
  accepts 内即可绑定；不在列表时返回 `CREDENTIAL_TYPE_MISMATCH`。
- [ ] **[PV0-D06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) Claude SDK 网关形状**：使用 baseUrl + tokenCredentialRef 可建立适配器，
  请求只在执行边界解析 token；配置、绑定与诊断中只有 ref id，没有 token 值。
- [ ] **[PV0-D07](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 不制造悬空引用**：删除被绑定适配器或凭证时，宿主列出依赖并拒绝直接删；
  解除或迁移绑定后才能删除。
- [ ] **[PV0-D08](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 错绑定不覆盖好绑定**：对现有 ready 车道提交无效新绑定；持久化失败后旧绑定
  仍可 dispatch，verified scope 不变。host contract 未登记的 lane、错拼、仅大小写不同或前后
  含空白的 lane 均在绑定和 dispatch 前返回 `CONFIG_INVALID`，不读取凭证、不调用 adapter。
- [ ] **[PV0-D09](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 角色不从名字推导**：fixture 先在宿主能力契约登记
  `main`、`subagent`、`coding-subagent` 三条精确 lane，再交叉发送两种 role；最终角色只等于已授权 `DispatchRequest.role`，lane 名、适配器
  和凭证类型都不能改变角色或记忆挂载规则。
- [ ] **[PV0-D10](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s5) 凭证获取入口有签发方**：credential type 只在 active issuer 声明后出现在
  TUI/API；移除 issuer 后入口消失，新建或导入无法回指 issuer 的 ref 返回
  `CREDENTIAL_ISSUER_UNAVAILABLE`，现役有效 ref 的值不泄漏；issuer 删除后的现役 ref 处置/迁移
  策略不属于 v0，本条不替产品决定删除语义。

## E. 升级、迁移与回滚

- [ ] **[PV0-E01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 成功升级原子切换**：v1 产生配置和绑定，v2 在副本上 migrate、validate、
  prepare、activate；提交前仍命中 v1，提交后整批命中 v2，再卸载 v1。
- [ ] **[PV0-E02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 迁移抛错回到 v1**：v1 → v2 的 migrate 抛错；返回 `MIGRATION_FAILED`，
  v1 插件、原配置、原绑定和原 verified scope 仍 ready。
- [ ] **[PV0-E03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 坏目标 schema 回到 v1**：migrate 返回不符合 v2 schema 的配置；结果同
  E02，不能留下被改写的旧配置。
- [ ] **[PV0-E04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) v2 激活失败回到 v1**：迁移与 prepare 成功、activate 失败；新版本资源
  全撤销，v1 的原配置、原绑定和原 verified scope 恢复 ready，返回 `ACTIVATE_FAILED`。
- [ ] **[PV0-E05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 缺迁移路径拒绝升级**：config schema 改变但插件无对应 migrate；返回
  `MIGRATION_FAILED`，不尝试猜字段或原地升级。
- [ ] **[PV0-E06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 迁移不接触 secret 值**：migrate 输入只有配置副本与 credential refs；
  用探针凭证库证明迁移函数没有读取凭证值的调用权限。
- [ ] **[PV0-E07](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s7) 升级扩权须显式确认**：固定同一插件的
  v1 ready fixture；下列九个分支各自只施加一项 mutation，读取 v1/v2 包内 canonical 注入四元组
  `{id, source, scope, body}`，其中 manifest `id` 是唯一键，`source` 是规范化的包内相对路径，
  `body` 是精确 UTF-8 正文，不能使用插件 description、历史确认、第二键或别名。每个分支在 v2
  完成 migrate 与目标 schema 校验后、activate 前都返回
  `UPGRADE_PERMISSION_CONFIRMATION_REQUIRED`，展示该分支的 canonical 差集；v1 插件、绑定、路由和原
  verified scope 继续 ready，v2 不得激活、公开或注入新正文。

  | 独立分支 | 唯一 v2 mutation |
  |---|---|
  | E07-P1 | 新增 `PermissionGrant` capability |
  | E07-P2 | 提高现有 `PermissionGrant.effect` |
  | E07-P3 | 增加现有 `PermissionGrant.operations` 值 |
  | E07-P4 | 增加现有 `PermissionGrant.literals` 值 |
  | E07-P5 | 移除 v1 原有 `PermissionGrant` literal 限制 |
  | E07-I1 | 新增 canonical context injection `id` |
  | E07-I2 | 只改变既有 `id` 的 `body` |
  | E07-I3 | 只改变既有 `id` 的 `source` |
  | E07-I4 | 只把既有 `id` 的 scope 从 `session` 改为 `resident` |

  另设两个收窄 fixture：删除既有 canonical context injection `id`，以及只把既有 `id` 的 scope 从
  `resident` 改为 `session`；两者均不触发确认，直接走原升级流程。对任一扩权分支给出本次升级的
  显式人工确认后，才允许继续 E01 的原子切换；没有扩权的 v2 不弹额外确认，直接走原升级流程。重启、
  显式取消或新升级会丢弃未确认 v2 副本；v0 不设数字 TTL。

## F. Readiness、投影与闭环

- [ ] **[PV0-F01](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s4) readiness 有 scope**：ready/degraded/blocked/quarantined 每种 fixture 都
  返回 resident、lane、operations 和验证时间；换住户或车道后不能沿用旧 ready。
- [ ] **[PV0-F02](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s8) 原因码稳定可判**：A–E 每条失败路径只以 RFC 第 8 节 reason code 之一
  作为机器判决，附加文本变化不影响断言。
- [ ] **[PV0-F03](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s9) 每条约束都有指定红格**：逐项执行下表登记的 mutation；实测失败集合必须
  包含该 mutation 指定的 PV0 id，不能用“任意一格变红”代替。fixture 的宪法常量独立于
  实现配置，不能跟着被测常量一起变化。
- [ ] **[PV0-F04](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s1) boot-time 不变量不可卸载**：伪插件尝试覆盖权限闸或事件留史 provider；
  安装在 validate 阶段被拒，现有不变量仍可用。
- [ ] **[PV0-F05](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s1) 壳共享魂私有**：插件包、manifest、配置导出和诊断中扫描住户人格、记忆、
  聊天 fixture 标记；均不得出现，插件只能经受控 capability 在当前 scope 临时访问。
- [ ] **[PV0-F06](../docs/design/plugin-protocol-v0.md#plugin-protocol-v0-s4) ready 必须有当前 scope 的可用性收据**：分别用 initialize 握手、版本查询
  和无副作用探针验证三类 capability；未运行探针、探针超时或返回身份不符时返回
  `CAPABILITY_UNVERIFIED` 且不进 ready 工具集。断言只证明可用性，不声称签名或供应链可信。

本次 #101 只落地了确定性 evaluator/readback contract 与窄 fixture（缺运行证据、真实路径失败、
scope/version/条件漂移和过期收据）；上述 F01/F02/F06 仍需完整的四状态、A–E 失败矩阵和三类
provider-like readback fixture 后再勾选。`npm run acceptance` 的 C1–C6 六盏灯不替代 PV0 F
系列验收，故此处保持未勾选。`publishedResources` 仍是生命周期 projection，本切片不声称
它受 readiness gate 控制；active 无收据时可能仍有已发布资源，但 readiness 必须为 unknown。

## 逐项 mutation 台账

实现阶段每项都要把下列变异真的施加到测试替身或实现分支；“预期红格”未出现在失败集合
就算 mutation 验证失败。变异描述是稳定验收输入，不得从被测实现的常量反向生成。

| PV0 id | mutation：故意删掉或改坏的约束 | 预期红格 |
|---|---|---|
| A01 | validated 前把能力放进目录 | A01 |
| A02 | 接受未知 manifest schema | A02 |
| A03 | 把不可解析 `requiresMist` 当兼容 | A03 |
| A04 | 允许 entrypoint/context source 逃逸或未知枚举 | A04 |
| A05 | required 缺失时继续 ready | A05 |
| A06 | manifest 校验前 import entrypoint | A06 |
| A07 | enabled=false 只隐藏 UI、不 dispose | A07 |
| A08 | 允许非法/冲突 plugin id 覆盖现役 | A08 |
| A09 | 允许 secret env 使用明文 value | A09 |
| A10 | 把未声明的 env 交给插件，或让插件从 process.env 取声明项 | A10 |
| B01 | 把 `/new` 字面量约束改成任意文本 | B01 |
| B02 | 把空 operations/literals 解释为通配 | B02 |
| B03 | 以插件的 read 覆盖宿主 irreversible | B03 |
| B04 | 在任一诊断路径输出 secret 探针 | B04 |
| B05 | 翻译时删除 effect 或 literals metadata | B05 |
| B06 | 让 MCP 声明外工具进入住户工具集 | B06 |
| B07 | 翻译结果额外加入无源 `run_arbitrary` | B07 |
| B08 | 在诊断中输出完整住户原话探针 | B08 |
| B09 | 把 lazy capability 当 eager 全量注入 schema | B09 |
| B10 | 注入包外或无来源标记的上下文正文 | B10 |
| B11 | 静默采用 server 漂移后的 instructions | B11 |
| B12 | 允许工具返回值把已知 secret 带入模型上下文 | B12 |
| B13 | 停用或卸载后仍把该插件守则留在 wakepack | B13 |
| B14 | 宿主把已解析 secret 或凭证值写入 settings / 配置快照 | B14 |
| C01 | prepare 阶段提前公开首个资源 | C01 |
| C02 | 第三个 register 失败后保留前两个 handle | C02 |
| C03 | activate 失败后跳过 rollback | C03 |
| C04 | 逐个而非原子公开资源批次 | C04 |
| C05 | 第二次 dispose 再次执行真实撤销 | C05 |
| C06 | 卸载清理前仍接受新调用 | C06 |
| C07 | revoke 失败后仍报告 disposed/ready | C07 |
| C08 | 把插件运行时异常抛到宿主顶层 | C08 |
| C09 | 一次返回 `PLUGIN_RUNTIME_FAILED` 的失败 call 后，让 scheduler 在可控 tick/队列排空观察窗内自动循环重试 | C09 |
| C10 | 把启动时 activate/dispose 日志协调当用户重试、协调后自动 ready/active，或清除失败记录并假装未安装 | C10 |
| C10 | 把写盘后未发布的 active 记录当作已发布：协调阶段补跑 `PreparedPlugin.activate()`，或直接投影为 active/ready | C10 |
| C10 | 写盘后未发布的记录只改状态位不回滚资源：跳过 `revoke`/`rollback` 直接写 `blocked`，把已 activate 的资源留在已提交状态 | C10 |
| C10 | 只把内存 `DisposableHandle` 当恢复能力，操作日志不写 recovery key；或重启协调重跑普通 `prepare`/`activate` 来重新拿句柄 | C10 |
| C10 | recovery key 缺失、重复、漂移或 `recover(context)` 失败后仍写 `blocked`/`disposed`，不进 `quarantined + RECOVERY_HANDLE_UNAVAILABLE` | C10 |
| C11 | 先持久化公开路由索引，再写 active 四元组 | C11 |
| C12 | quarantined 进入后自动重试、把重复 dispose 当作宿主 `retryCleanup` 显式清理重试、把重试失败当 disposed，或清掉剩余资源/人工处理记录 | C12 |
| C13 | 先调 `PreparedPlugin.activate()` 发布，再逐资源提交 | C13 |
| C14 | 仅凭声明版本字符串当恢复凭据：不比对模块内容摘要就调用 `recover`，或摘要不符仍写 `blocked` 继续协调 | C14 |
| D01 | 仅以 lane 为键，忽略 residentId | D01 |
| D02 | 给 subagent 挂载住户记忆 | D02 |
| D03 | 显式换道时沿用原车道权限结果 | D03 |
| D04 | 允许 claude_oauth 绑定 pi | D04 |
| D05 | 忽略适配器 accepts 接受任意凭证类型 | D05 |
| D06 | 把网关 token 值内联进 adapterConfig | D06 |
| D07 | 删除凭证时不检查现役绑定 | D07 |
| D08 | 无效新绑定覆盖原 ready 绑定 | D08 |
| D09 | 在 host contract 未先精确登记 fixture lane 时，或从 lane 名推导 main/subagent 角色 | D09 |
| D10 | 无 active issuer 仍展示、签发或导入无 issuer 的 credential ref | D10 |
| E01 | v2 active 前把调用切到新版本 | E01 |
| E02 | migrate 抛错后留下被改写的 v1 配置 | E02 |
| E03 | 跳过 v2 schema 校验并提交坏配置 | E03 |
| E04 | v2 activate 失败后以缩水的 verified scope 恢复 v1 ready | E04 |
| E05 | 缺 migrate 时猜字段并原地升级 | E05 |
| E06 | 给 migrate 暴露读取凭证值的接口 | E06 |
| E07-P1 | 对新增 `PermissionGrant` capability 跳过确认 | E07 |
| E07-P2 | 对提高 `PermissionGrant.effect` 跳过确认 | E07 |
| E07-P3 | 对增加 `PermissionGrant.operations` 值跳过确认 | E07 |
| E07-P4 | 对增加 `PermissionGrant.literals` 值跳过确认 | E07 |
| E07-P5 | 对移除 v1 `PermissionGrant` literal 限制跳过确认 | E07 |
| E07-I1 | 对新增 canonical context injection `id` 跳过确认 | E07 |
| E07-I2 | 对只改变既有 `id` 的 `body` 跳过确认 | E07 |
| E07-I3 | 对只改变既有 `id` 的 `source` 跳过确认 | E07 |
| E07-I4 | 对 `session → resident` 跳过确认 | E07 |
| F01 | 把一个车道的 ready 投影到所有 scope | F01 |
| F02 | 只返回自由文本错误、不返回稳定 code | F02 |
| F03 | mutation runner 接受“任意测试变红” | F03 |
| F04 | 允许插件覆盖 boot-time 权限闸 | F04 |
| F05 | 把住户人格 fixture 写入插件配置导出 | F05 |
| F06 | 未取得 capability 可用性收据仍标 ready | F06 |

## 完成定义

协议实现完成必须同时满足：A–F 全部自动化并全绿；逐项执行 mutation 台账且每个预期红格
都实际变红；
`npm run lint && npm run typecheck && npm test && npm run acceptance:strict` 全绿；评审能从
每个 RFC 约束直接指到一个 PV0 id，并从每个 PV0 id 指回唯一规范段落。

本次 #67 是文档修订；仓库当前没有 mutation runner，**本次 mutation 未执行**。C09、C10、C12
和 E07 只有在其上述 reason code、fixture、确定性断言和指定 mutation 全部实现并实际变红时，
才能作为协议实现完成的证据。
