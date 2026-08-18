# 插件协议 v0 RFC

状态：**草案，#67 收口修订完成，待复审**。本稿只定义协议和可判卷形状，不实现具体插件，
不设计插件市场。验收清单见
[../../acceptance/plugin-protocol-v0.md](../../acceptance/plugin-protocol-v0.md)。

规范词 `必须`、`不得`、`可以` 分别表示协议义务、协议禁令和实现可选项。

<a id="plugin-protocol-v0-s1"></a>
## 1. 边界与代价

插件只通过宿主提供的注册上下文获得能力，不能直接写住户状态、读凭证库或绕过权限闸。
v0 支持四类插件：`channel_adapter`、`frontend`、`tool_capability`、`bridge`；一个插件可以
声明多类，但每项能力、权限和资源都要逐项登记。

五条 boot-time 不变量——模型可见即已记录、事件留史、权限闸、身份关系修订链、私密
不泄露——可以由可替换实现提供，但不得被插件卸载或覆盖。

代价：v0 把校验、事务注册、权限和故障隔离放进宿主，插件作者要写更多声明；协议保证
的是宿主边界内的 fail-closed，不把同进程插件伪装成安全沙箱。需要抵御恶意原生代码时，
实现必须另加进程或沙箱边界。v0 把同进程插件代码视为受信任代码：宿主能完整追踪并撤销
经 `PluginPrepareContext` 登记的资源，但无法检测插件绕过 context 直接调用 Node 原生 API
制造的计时器、文件句柄或网络连接。此类未登记资源违反作者约定，却不在 v0 的机制保证内。

<a id="plugin-protocol-v0-s2"></a>
## 2. Manifest 是安装前唯一入口

每个插件包根目录必须有纯数据文件 `mist-plugin.json`。宿主在加载插件代码前解析它；
manifest 不得依赖执行 JavaScript 才能取得。未知字段可以保留供未来版本读取，但未知的
schema 版本、插件类别、权限种类、能力种类或版本范围语法都必须按不兼容拒装，不得猜默认值。

```ts
type PluginKind = "channel_adapter" | "frontend" | "tool_capability" | "bridge";
type Effect = "read" | "reversible" | "irreversible";
type InjectionMode = "eager" | "lazy";

interface PluginManifestV0 {
  manifestSchemaVersion: 0;
  id: string;                  // 全局稳定、小写、不可复用
  version: string;             // 完整 SemVer
  requiresMist: string;        // SemVer range；解析失败即不兼容
  entrypoint: string;          // 包内相对路径，不得逃出插件根目录
  kinds: readonly PluginKind[];
  configSchemaVersion: number; // 非负整数，只能经 migrate 改变
  capabilities: readonly CapabilityDeclaration[];
  contextInjections: readonly ContextInjectionDeclaration[];
  env: readonly EnvironmentDeclaration[];
  credentials: readonly CredentialRequirement[];
  permissions: readonly PermissionGrant[];
}

interface CapabilityDeclaration {
  id: string;                  // 插件内稳定 id
  description: string;
  effect: Effect;
  operations: readonly string[];
  injectionMode: InjectionMode; // eager=完整 schema；lazy=目录项，按需取 schema
}

interface ContextInjectionDeclaration {
  id: string;                  // 插件内稳定 id
  source: string;              // 包内 UTF-8 文本相对路径，不得逃出插件根
  scope: "resident" | "session";
}

interface EnvironmentDeclaration {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

type CredentialType = "claude_oauth" | "codex_oauth" | "grok_oauth" | "api_key";

interface CredentialRequirement {
  slot: string;
  accepts: readonly CredentialType[];
  required: boolean;
}

interface PermissionGrant {
  capabilityId: string;
  effect: Effect;
  operations: readonly string[];
  literals?: Readonly<Record<string, readonly string[]>>;
}

interface PluginInstanceConfig {
  enabled: boolean;
  settings: unknown;
  environment: readonly EnvironmentBinding[];
  credentialRefs: Readonly<Record<string, CredentialRef>>; // key = manifest slot
}

interface EnvironmentBinding {
  name: string;
  value?: string;      // 只允许对应 secret:false
  secretRef?: string;  // 只允许对应 secret:true；值在执行边界解析
}
```

`id` 必须匹配 `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`，不得包含路径分隔符、空白或大写字母。
同一宿主内 id 全局唯一：普通安装遇到已有 id 返回 `PLUGIN_ID_CONFLICT`；只有显式 upgrade
操作可以用同一 id 的新版本进入第 7 节事务，不能靠后装覆盖前装。

`contextInjections` 是所有插件来源非工具文本的完整清单。宿主在 import 前读取 `source`，
路径校验与 entrypoint 相同；正文随包版本冻结并带 plugin id、注入 manifest `id`、源路径和 scope 的
来源标记。MCP `instructions` 或其他运行期文本只有与已声明源文件逐字一致时才能采用；
未声明或漂移的文本必须显式拒绝并返回 `CONTEXT_INJECTION_MISMATCH`，不得静默采用或静默
丢弃。`resident` scope 可以随住户重建再次装配，`session` scope 只属于当前会话；两者都
不是人格或记忆写权限，插件不能借注入修改住户私有文件。`InjectionMode` 只描述工具 schema
的容量策略，不适用于上下文注入正文；插件 active 时，已声明正文按 scope 装配，不允许实现
自行猜测 lazy/eager 语义。

升级比较使用的有效注入声明是经路径校验后、从各自 v1/v2 包内读取的 canonical 四元组
`{ id, source, scope, body }`。manifest 字段 `id` 是该四元组的唯一键；协议不得定义、接受
或推导第二键或别名。`source` 是规范化的包内相对路径，`body` 是该 `source` 的
精确 UTF-8 正文。宿主必须保存可审计的 v1/v2 四元组差集，逐字比较正文；不得以插件自报的
`description`、运行期文本、历史确认或版本号替代此比较。

`operations` 必须是宿主能力契约中已登记的操作名；合法 lane 集合和可收窄的操作参数也由同一
份宿主能力契约唯一决定。当前契约里的 `primary`、`coding` 只是示例，不是协议硬编码的
完整集合。插件只能在宿主已登记的 schema 明确支持时声明 literal 子集；例如只能触发换窗的
桥接可以声明 `literals: { text: ["/new"] }`，不能申请任意 `terminal_send`。宿主拒绝未登记
的操作、参数、值或 literal；空数组不代表通配。lane 名大小写敏感，绑定和 dispatch 前不得
trim、套别名或模糊纠错，也不得从 adapter、credential 或 role 推导；未知 lane 以现有
`CONFIG_INVALID` fail-closed，不能进入绑定或 dispatch。

`env` 只声明需求，不携带值。`secret: true` 的值不得进入插件配置快照、诊断、错误文本或
事件正文。凭证比普通 secret env 更严格：manifest 只声明槽位与可接受类型，实际绑定只
传 `credentialRef`，插件永远看不到凭证库的枚举能力。

`value` 与 `secretRef` 必须二选一并与 manifest 的 `secret` 标志一致。`enabled: false`
保留设置但不进入 prepare；从 true 切到 false 必须走完整卸载，从 false 切到 true 必须
重新校验并走完整注册事务，不能靠隐藏 UI 冒充停用。

代价：字面量权限会让动态命令类插件需要更细的宿主能力或显式人工授权，不能用一个
“terminal=true”偷懒换取万能键盘。

<a id="plugin-protocol-v0-s3"></a>
## 3. 注册是事务，不是一串回调

宿主按 `discover → validate → prepare → activate → active` 推进。只有 `active` 状态的能力
可以被绑定或调用；任何较早状态都不可见。插件模块接口固定为：

```ts
interface PluginModuleV0 {
  migrate?(request: MigrationRequest): Promise<unknown>;
  prepare(context: PluginPrepareContext): Promise<PreparedPlugin>;
}

interface PluginPrepareContext {
  readonly pluginId: string;
  readonly config: unknown;
  register(resource: ResourceDeclaration): DisposableHandle;
}

type ResourceKind = "route" | "tool" | "listener" | "timer" | "connection";

interface ResourceDeclaration {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly capabilityId?: string;
  activate(): Promise<void>; // 由宿主在原子提交阶段调用；prepare 时不得已对外可达
  dispose(): Promise<void>;
}

interface DisposableHandle {
  readonly id: string;
  revoke(): Promise<void>; // 幂等；宿主也持有并可强制调用
}

interface PreparedPlugin {
  activate(): Promise<ActivePlugin>;
  rollback(): Promise<void>; // prepare 的反向操作，幂等
}

interface ActivePlugin {
  dispose(): Promise<DisposeReport>; // 幂等
}

interface DisposeReport {
  readonly revoked: readonly string[];
  readonly failed: readonly { id: string; reasonCode: string }[];
}
```

完整状态机如下，箭头外的跳转均非法：

```text
discovered → validated → prepared → active → disposing → disposed
     │           │           │          │          │
     └───────────┴───────────┴──────────┴──────────┴→ blocked
                             └─ rollback → blocked（保留启用意图）
                                        dispose 不完整 → quarantined
                                                          │
                                 显式清理重试成功 ─────────┘→ disposed
                                 显式清理重试失败 ───────────→ quarantined

blocked ─显式修复或用户重试→ discovered（重新走完整新生命周期）
blocked ─显式停用并清理→ disposing → disposed / quarantined
```

`DisposableHandle.revoke` 是**单个资源**的撤销，`PreparedPlugin.rollback` 是**整次 prepare** 的
逆操作，`ActivePlugin.dispose` 是**整插件卸载**；三者各自幂等，不能泛称为同一个 disposer。
任一阶段进入 `blocked` 后不得自动回到 `ready`，也不得直达 `active`：只能由显式修复或用户重试
重新从 `discovered` 走完整生命周期，或由显式停用进入清理。`dispose` 不完整进入
`quarantined`，其唯一出边仍是宿主显式清理重试。

`prepare` 期间的每次 `register` 都先写入宿主拥有的注册日志，并返回宿主同样持有的
`DisposableHandle`。协议合规插件应当只经 context 创建对外资源；v0 对宿主管理资源提供
事务保证，不声称能拦截受信任同进程代码直接调用 Node 原生 API。`activate` 成功后，宿主
以一次原子提交公开整批资源；中途失败则按注册逆序撤销全部句柄并调用 `rollback`。部分
成功不得泄漏为半个 active 插件。

生命周期事务必须跨宿主进程边界可恢复。宿主在执行第一个生命周期副作用前，先持久化带
`operationId` 的操作日志；日志至少记录 plugin id、操作种类（activate/dispose）、当前阶段、
已登记资源 id 与已完成撤销回执。active 终态必须先与配置、绑定和 verified scope 原子写盘，
再公开路由与能力；因此不存在“已经公开但没有权威 active 记录”的合法顺序。任何可枚举的
插件入口、路由索引与工具目录都必须是已持久化 active 四元组的子集，不得把公开索引作为一笔
更早、更独立的提交。

宿主启动时必须先协调未完成操作，再发布任何插件入口：中断在 activate 提交前的操作保持
不可达，并按持久化注册日志逆序回滚；协调完成后停在 `blocked + ACTIVATE_FAILED`，保留
plugin id、`operationId`、`enabled: true` 的启用意图、配置与绑定，直到显式重试，或住户把
`enabled` 改为 false 后进入 disposed。不能把一次失败启用擦成“从没安装过”。中断在 dispose
中途的操作保持不可达，从最后一笔撤销回执继续清理；失败则进入 quarantined。
`quarantined`、剩余资源 id、reason code 与操作日志都必须跨重启保留；不得因重启清空内存态
而把孤儿中间态投影为 ready。协调结束前，该插件以 `LIFECYCLE_RECOVERY_PENDING` 显式
blocked，不允许自动执行普通 prepare/activate/call 路径。这是 C10 的**启动时日志协调**，
不是用户重试；协调结束后若为 `blocked`，仍须等待上文的显式修复/用户重试或显式停用。

`quarantined` 的恢复只能由宿主提供的显式清理重试触发，不属于启动协调，也不重新经过
prepare/activate/call。重试从持久化的剩余资源清单和撤销回执继续：全部资源撤销成功后进入
`disposed`；任一资源再次撤销失败则继续留在 `quarantined`，追加本次失败的 reason code、
资源 id 和人工处理路径/残留清单。没有显式操作时不得自动重试，更不得把失败重试伪装成
`disposed`。显式清理重试是宿主独立的操作（例如 `retryCleanup(pluginId)`），不等于再次调用
`dispose`；`quarantined` 下重复 `dispose` 必须幂等返回 `quarantined`，不能触发重试。

卸载顺序固定为：先从路由和能力目录撤销可达性，并按 plugin id 从住户模型上下文、启动包及
后续重建输入中撤下全部 `contextInjections`，拒绝新调用与新注入；再等待或取消在途调用；
最后逆序撤销资源并调用 `dispose`。重复卸载必须返回同一终态。某个撤销失败时，插件状态
进入 `quarantined`，相关路由继续 fail-closed，宿主记录资源 id 和稳定 reason code；
不得为了“看起来卸载成功”留下任何已登记或经宿主管理的监听器、出站连接、定时器、工具或
上下文守则。处于 `quarantined` 时，宿主只允许走显式清理重试这一条出边；重复 `dispose`
仍返回同一 `quarantined` 隔离态，不算显式重试。独立重试成功才可进入 `disposed`，重试失败
继续保留隔离记录和人工处理清单。

代价：事务注册需要宿主持久化操作日志、撤销回执和终态，并在启动时先做协调；协议要求插件
作者把 import-time 副作用改造进 prepare/activate 生命周期，但 v0 的同进程信任边界不能
机械拦截故意绕开的 Node 原生调用。

<a id="plugin-protocol-v0-s4"></a>
## 4. 故障只影响插件，不拖死地基

宿主在生命周期钩子和每次能力调用外建立错误边界。同步抛错、异步拒绝、超时和无效返回
都只把当前插件或当前调用标记失败；其他插件、住户存储和 boot-time 不变量继续可用。
失败插件不会自动无限重试。恢复必须是显式重试、重新启用或新版本安装。

一次 active 插件 `call` 因抛错或超时返回 `PLUGIN_RUNTIME_FAILED` 后，宿主不得自行重试该次
调用，也不得让调度器重新进入 prepare 或 activate。C09 的可验证观察使用 fixture 时钟或 scheduler
tick 推进至少一个失败后的周期并排空队列；它不使用真实 sleep，也不为生产系统定义 TTL。

`readiness` 至少区分：

- `ready`：active 且依赖、绑定、凭证和环境均满足；
- `degraded`：插件仍可服务已声明的子集，缺失项逐条列出；
- `blocked`：不兼容、缺必需配置、权限拒绝或迁移失败；
- `quarantined`：撤销不完整或运行时越界，所有对外入口已关闭。

状态必须带 `verifiedScope`，只说明在哪个住户、车道、操作集合与时间点验证过；不得把
“进程活着”投影成所有绑定可用。每项暴露为 ready 的 capability 还必须在该 scope 留下一份
确定性可用性收据，例如 server initialize 握手、版本查询或无副作用探针；拿不到收据返回
`CAPABILITY_UNVERIFIED` 并进入 degraded/blocked。该收据只证明当前声明的能力可用，不证明
二进制来源真实或代码可信；签名与供应链认证仍不属于 v0。

代价：隔离会把一部分错误从崩溃变成显式降级，运维面必须展示 blocked/quarantined，
否则故障只会从停机变成静默缺能力。

<a id="plugin-protocol-v0-s5"></a>
## 5. 凭证、适配器与用途车道

凭证独立存储，登录委托执行通道完成；本协议不设计 OAuth 登录或刷新流程。配置和绑定的
公共形状为：

```ts
interface CredentialRef {
  readonly id: string;
  readonly type: CredentialType;
  readonly issuerId: string;
}

type AgentRole = "main" | "subagent";

interface LaneBinding {
  readonly residentId: string;
  readonly lane: string;       // 合法集合由宿主能力契约登记；primary/coding 仅为示例
  readonly adapterId: string;
  readonly credentialRef: CredentialRef;
  readonly adapterConfig?: {
    readonly baseUrl?: string;
    readonly tokenCredentialRef?: CredentialRef;
  };
}

interface DispatchRequest {
  readonly residentId: string;
  readonly role: AgentRole;
  readonly lane?: string;
  readonly taskToolPolicy?: readonly string[];
}
```

绑定的键是 `residentId × lane`。合法 lane 集合只认宿主能力契约登记的当前集合；协议示例中的
`primary`、`coding` 不构成额外的固定集合。lane 比较大小写敏感，宿主不得 trim、接受别名或
模糊纠错，也不得从 adapter、credential 或 role 推导 lane。绑定保存和 dispatch 前若 lane
不在契约集合内，必须以现有 `CONFIG_INVALID` fail-closed，不加载凭证、不调用 adapter，也不
覆盖上一份有效绑定。`main` / `subagent` 是运行角色；宿主不得从 lane 名、适配器或凭证类型
推导角色，角色只取自已经过授权的 `DispatchRequest.role`。
主 agent 挂住户生命周期和记忆，默认工具集精简；subagent 不挂住户记忆，工具按当前任务
显式开放。subagent 未指定车道时继承主请求的车道；显式换道时必须重新过绑定、权限和
工具策略校验。

`claude_oauth` 只能绑定 Claude SDK 适配器；绑定给 pi 或其他适配器必须拒绝。
`codex_oauth`、`grok_oauth` 和 `api_key` 不受这一条专属限制，但仍要满足适配器声明的
凭证类型。Claude SDK 适配器必须接受可选 `baseUrl + tokenCredentialRef`，以支持兼容
Claude 协议的网关；token 仍由凭证引用提供，不得内联。

凭证类型是 wire type，不等于宿主一定能签发。宿主只展示当前 active credential issuer
明确提供的获取类型，创建 `CredentialRef` 时记录 `issuerId`；issuer 不存在时，TUI/API
不得展示对应登录入口，外部导入的 ref 也必须能回指现役 issuer。v0 不决定 issuer 删除后
现役 ref 的删除、处置或迁移语义；它只禁止新建悬空 ref 和 secret 落入协议载体，详见第 10 节。
RFC 起草时的
[pi provider 表](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
已列出 Claude、OpenAI Codex 与 xAI/Grok subscription OAuth；未来类型或外部流程仍按同一
issuer 规则接入，本协议不把登录步骤写进地基。

绑定校验发生在持久化前；失败不能覆盖上一份可用绑定。删除适配器或凭证前，宿主必须
列出受影响绑定并先解除或迁移，不能制造悬空引用。

代价：严格的凭证类型约束会拒绝一些技术上“也许能跑”的组合；这是用显式可审计的通道
语义换取少踩计费和身份边界的坑。2026-08-17 的动机是 `claude_oauth → Claude SDK`
必须保留订阅身份与计费边界；同时 `baseUrl + tokenCredentialRef` 支持兼容 Claude 网关，
又不把 token 内联进配置、绑定或诊断。代价是适配器兼容性不能用一个通用 token 形状偷换
订阅身份或计费归属，网关还必须在执行边界解析其独立凭证引用。

<a id="plugin-protocol-v0-s6"></a>
## 6. skill 与 MCP 都是工具能力

skill 和 MCP 统一归 `tool_capability` 插件，manifest 必须声明提供的能力、操作和副作用
等级。它们不是绕过权限契约的两条特权通道。工具权限与上下文容量正交：
`injectionMode: eager` 可以在 active 时装入完整 schema；`lazy` 只把 capability id、来源和
单行 description 放入可发现目录，完整 schema 经宿主取回通道按需加载。取回不能改变原
权限判定，也不能把 lazy 静默升级为 eager。

适配器负责翻译注入方式：

- Claude SDK：原生挂载 skills 目录和 `mcp_servers`；
- pi：skill 转为有来源标记、可裁剪的 prompt 段；
- MCP：由 mist host 收编 server 暴露的工具，再按住户、角色和任务工具策略分发。

skill prompt、MCP `instructions` 等非工具文本统一走 `contextInjections`。适配器只能注入
包内已声明正文并保留来源标记；运行期 server 下发未声明或与包内正文不一致的文本时，
该文本不得进入住户上下文，capability 显式 degraded/blocked。宿主必须让住户看见“哪段
注入因何被拒”，不能让住户在不知情的残缺守则上继续判断。

翻译后必须保留稳定的原始 capability id、来源 plugin id、effect 和权限约束。对一个
verified scope，翻译输出的工具与已授权源操作必须逐项可逆映射：无来源工具、额外操作和
静默丢失都不允许；目标通道不支持某项时，该 capability 进入 degraded/blocked，而不是
折叠成万能工具或假装完整 ready。

代价：同一 skill 在不同适配器上的呈现不保证字节相同，只保证能力与权限语义等价；
适配器测试要覆盖每一种翻译，而不能只测源 manifest。
lazy 模式增加一次 schema 取回，并要求适配器维护可发现目录；显式上下文注入则牺牲运行期
随服务端即时改 instruction 的便利，换取安装前可读、升级可 diff、出事可追溯。

<a id="plugin-protocol-v0-s7"></a>
## 7. 版本兼容与升级迁移

安装前依次校验 `manifestSchemaVersion`、`requiresMist`、插件版本和配置 schema。
版本范围解析失败一律视为不兼容。升级使用 copy-on-write：旧插件、旧配置和旧绑定在新版本
active 前保持可恢复，新版本不得原地改写旧配置。

升级时，宿主必须在目标 schema 校验完成后、v2 `activate` 之前，取得现役 v1 的有效
`PermissionGrant` 集合及第 2 节的有效注入四元组，并与 v2 逐项比较。每个注入只以 manifest
字段 `id` 作为唯一键，比较的固定形状为 `{ id, source, scope, body }`：`source` 是规范化的包内
相对路径，`body` 是精确 UTF-8 正文；不得使用第二键或别名。权限比较以
`capabilityId` 为键；`effect` 的风险顺序固定为 `read < reversible < irreversible`，`operations`
和 `literals` 的允许值按集合包含关系比较。v2 出现 v1 没有的 capability、提高 effect、增加
operation、增加 literal 值，或移除 v1 原有的 literal 限制，均属于扩权。注入方面，新增 `id`、
只改变 `body`、只改变 `source`，或 scope 从 `session` 升为 `resident`，均属于扩权；删除 `id`，
或 `resident → session`，属于收窄。比较必须基于宿主能力契约归一化后的授权结果和包内 canonical
正文，不能用插件自报描述、版本号、配置文件差异或历史确认替代。

没有扩权时，升级继续走原有流程，不增加额外确认。出现任一权限或注入扩权时，宿主必须展示
可审计的 v1/v2 差集（含授权项和注入 `{id, source, scope, body}` 差异），并针对本次升级取得
显式人工确认；确认之前不得激活或公开 v2，也不得公开新注入，v1 的插件、绑定、路由和原
verified scope 继续保持 ready。没有确认时，升级事务返回
`UPGRADE_PERMISSION_CONFIRMATION_REQUIRED` 并保持 blocked；不得把配置写入、启动重试或过去的
确认记录当作本次确认。确认后才可继续
copy-on-write 的 prepare/activate 和原子切换，后续失败仍按本节既有回滚路径处理。

`UPGRADE_PERMISSION_CONFIRMATION_REQUIRED` 不属于启动协调可恢复的 activate/dispose 操作；宿主
重启、显式取消或发起另一升级后，待确认的 v2 升级副本和本次确认资格一并作废，v1 继续保持
ready，用户必须重新发起升级、重新计算差集并取得本次显式确认。v0 不定义任意数字 TTL：待确认
副本只存活于本次未结束升级的生命周期，代价是中断后需重新 prepare/比较，而不是保留一份无法
审计其时效的候选版本。

```ts
interface MigrationRequest {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly config: unknown; // 深拷贝；不含凭证值
}
```

迁移返回新配置后，宿主用目标 schema 再校验，随后在隔离区 prepare/activate。只有全部
成功才原子切换版本和配置，并按正常卸载流程撤销旧版本。任一步失败都丢弃新副本，恢复
旧插件、旧配置和旧绑定；失败不得消耗或改写旧凭证引用。

缺少必要迁移路径、跳版本不被支持、迁移抛错、返回坏 schema 或新版本激活失败，均为
`blocked`。宿主不得把“保留了配置文件”当作回滚完成；旧版本必须能重新达到原 verified
scope 的 ready。

代价：升级期间会短暂保留两份插件与配置，占用更多磁盘和资源；这是可回滚的成本。

<a id="plugin-protocol-v0-s8"></a>
## 8. 稳定失败语义

所有拒绝与失败至少给出以下稳定 reason code，错误详情可以追加但不能替代 code：

| reason code | 触发条件 | 宿主终态 |
|---|---|---|
| `MANIFEST_INVALID` | 字段、路径、枚举或重复 id 无效 | blocked，未加载代码 |
| `HOST_INCOMPATIBLE` | schema / `requiresMist` 不兼容或不可解析 | blocked，未加载代码 |
| `PLUGIN_ID_CONFLICT` | 普通安装与现役插件 id 冲突 | blocked，现役插件不变 |
| `CONFIG_INVALID` | instance config、env 绑定形状或 schema 无效 | blocked，未解析 secret |
| `REQUIREMENT_MISSING` | 必需 env、配置或凭证引用缺失 | blocked |
| `CREDENTIAL_TYPE_MISMATCH` | 凭证类型与适配器或槽位不符 | 旧绑定不变 |
| `CREDENTIAL_ISSUER_UNAVAILABLE` | credential ref 无可用签发方或来源不可验证 | 不展示入口，拒绝绑定 |
| `PERMISSION_DENIED` | 操作、参数或字面量未授权 | 当前调用失败，无副作用 |
| `PREPARE_FAILED` | prepare 抛错、超时或返回无效 | 全量 rollback，未公开 |
| `ACTIVATE_FAILED` | activate 失败或其中断恢复完成 | 全量 rollback，blocked 且未公开；保留启用意图，等待显式重试或停用 |
| `MIGRATION_FAILED` | 迁移或目标 schema 校验失败 | 旧版本保持 ready |
| `UPGRADE_PERMISSION_CONFIRMATION_REQUIRED` | v2 有相对 v1 的 `PermissionGrant` 或 canonical context injection 扩权，且本次升级未获显式人工确认 | 升级事务 blocked；v1 保持 ready，v2 未激活、未公开新注入 |
| `DISPOSE_INCOMPLETE` | 任一资源撤销失败 | quarantined，对外入口关闭；只能由显式清理重试进入 disposed，重试失败继续隔离并保留案底 |
| `LIFECYCLE_RECOVERY_PENDING` | 检出未完成的 activate/dispose 操作日志 | blocked 且入口关闭；启动协调完成后才进入确定终态 |
| `PLUGIN_RUNTIME_FAILED` | active 插件调用抛错或超时 | 当前调用失败；按策略降级或 blocked |
| `CONTEXT_INJECTION_MISMATCH` | 运行期注入未声明或与包内正文不一致 | 拒绝注入；degraded/blocked |
| `SENSITIVE_OUTPUT_BLOCKED` | 插件输出或注入试图把已知 secret 带入模型上下文 | 当前调用失败；按策略降级或 blocked |
| `CAPABILITY_UNVERIFIED` | capability 无法取得当前 scope 的确定性可用性收据 | degraded/blocked，不进入 ready 工具集 |

诊断事件只能记录 plugin id、版本、资源 id、reason code、verified scope 和脱敏详情；
不得记录 secret env、token、OAuth 内容或完整用户输入。插件工具返回、上下文注入和适配器
翻译产物在进入模型可见上下文前还必须经过敏感值闸：命中当前执行边界已解析的 secret 值
时以 `SENSITIVE_OUTPUT_BLOCKED` 拒绝，不能指望后续摘要或记忆层替插件擦除。

<a id="plugin-protocol-v0-s9"></a>
## 9. 规范到判卷的对应

| RFC 规范面 | 验收区 | 主要红灯 |
|---|---|---|
| manifest、启停、host 兼容 | A | import 前拒装、停用后资源仍可达 |
| 权限、secret、skill/MCP 翻译与上下文注入 | B | 越权、secret 进上下文、翻译扩权、未声明或卸载后残留注入 |
| 生命周期、事务注册、故障隔离 | C | 半注册、公开早于权威提交、重复清理、注销留活线、拖死地基 |
| 住户×车道、角色、凭证约束 | D | 串房、角色混维、错凭证覆盖好绑定 |
| 版本升级、配置迁移、回滚与注入扩权确认 | E | 原地改配置、失败后 v1 不可用、未确认新守则公开 |
| readiness scope、不变量与变异验证 | F | 假 ready、无稳定原因码、约束删掉仍全绿 |

<a id="plugin-protocol-v0-s10"></a>
## 10. 非目标

- 不实现任何具体插件或适配器；
- 不定义插件发现站、签名分发、评分、市场或自动更新服务；
- 不以可用性探针冒充二进制身份、签名或供应链认证；
- 不承诺第三方插件代码是可信沙箱；
- 不把住户人格、记忆或聊天内容放进插件包；
- 不定义 `secretRef` 的存储后端、加密、轮换，或 issuer 删除后现役 ref 的产品处置与迁移策略；
  协议只保留不透明 ref，不落 secret。没有 active issuer 时不得展示对应入口、不得新建或导入
  无法回指现役 issuer 的 ref，也不得制造悬空 ref；现役 ref 的删除语义由产品另行决定；
- 不允许插件协议改写已决的通道政策、住户连续性或权限审批点。
