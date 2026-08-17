# 插件协议 v0 RFC

状态：**草案，等待 #51 评审**。本稿只定义协议和可判卷形状，不实现具体插件，
不设计插件市场。验收清单见
[../../acceptance/plugin-protocol-v0.md](../../acceptance/plugin-protocol-v0.md)。

规范词 `必须`、`不得`、`可以` 分别表示协议义务、协议禁令和实现可选项。

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

## 2. Manifest 是安装前唯一入口

每个插件包根目录必须有纯数据文件 `mist-plugin.json`。宿主在加载插件代码前解析它；
manifest 不得依赖执行 JavaScript 才能取得。未知字段可以保留供未来版本读取，但未知的
schema 版本、插件类别、权限种类、能力种类或版本范围语法都必须按不兼容拒装，不得猜默认值。

```ts
type PluginKind = "channel_adapter" | "frontend" | "tool_capability" | "bridge";
type Effect = "read" | "reversible" | "irreversible";

interface PluginManifestV0 {
  manifestSchemaVersion: 0;
  id: string;                  // 全局稳定、小写、不可复用
  version: string;             // 完整 SemVer
  requiresMist: string;        // SemVer range；解析失败即不兼容
  entrypoint: string;          // 包内相对路径，不得逃出插件根目录
  kinds: readonly PluginKind[];
  configSchemaVersion: number; // 非负整数，只能经 migrate 改变
  capabilities: readonly CapabilityDeclaration[];
  env: readonly EnvironmentDeclaration[];
  credentials: readonly CredentialRequirement[];
  permissions: readonly PermissionGrant[];
}

interface CapabilityDeclaration {
  id: string;                  // 插件内稳定 id
  description: string;
  effect: Effect;
  operations: readonly string[];
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

`operations` 必须是宿主能力契约中已登记的操作名。带副作用的操作如果存在可收窄参数，
manifest 必须把允许值声明到字面量级；例如只能触发换窗的桥接应声明
`literals: { text: ["/new"] }`，不能申请任意 `terminal_send`。宿主拒绝未声明的操作、
参数和值；空数组不代表通配。

`env` 只声明需求，不携带值。`secret: true` 的值不得进入插件配置快照、诊断、错误文本或
事件正文。凭证比普通 secret env 更严格：manifest 只声明槽位与可接受类型，实际绑定只
传 `credentialRef`，插件永远看不到凭证库的枚举能力。

`value` 与 `secretRef` 必须二选一并与 manifest 的 `secret` 标志一致。`enabled: false`
保留设置但不进入 prepare；从 true 切到 false 必须走完整卸载，从 false 切到 true 必须
重新校验并走完整注册事务，不能靠隐藏 UI 冒充停用。

代价：字面量权限会让动态命令类插件需要更细的宿主能力或显式人工授权，不能用一个
“terminal=true”偷懒换取万能键盘。

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
                             └─ rollback → disposed
                                        dispose 不完整 → quarantined
```

`prepare` 期间的每次 `register` 都先写入宿主拥有的注册日志，并返回宿主同样持有的
`DisposableHandle`。协议合规插件应当只经 context 创建对外资源；v0 对宿主管理资源提供
事务保证，不声称能拦截受信任同进程代码直接调用 Node 原生 API。`activate` 成功后，宿主
以一次原子提交公开整批资源；中途失败则按注册逆序撤销全部句柄并调用 `rollback`。部分
成功不得泄漏为半个 active 插件。

卸载顺序固定为：先从路由和能力目录撤销可达性，拒绝新调用；再等待或取消在途调用；
最后逆序撤销资源并调用 `dispose`。重复卸载必须返回同一终态。某个撤销失败时，插件状态
进入 `quarantined`，相关路由继续 fail-closed，宿主记录资源 id 和稳定 reason code；
不得为了“看起来卸载成功”留下任何已登记或经宿主管理的监听器、出站连接、定时器或工具。

代价：事务注册需要宿主保存注册日志和终态；协议要求插件作者把 import-time 副作用改造进
prepare/activate 生命周期，但 v0 的同进程信任边界不能机械拦截故意绕开的 Node 原生调用。

## 4. 故障只影响插件，不拖死地基

宿主在生命周期钩子和每次能力调用外建立错误边界。同步抛错、异步拒绝、超时和无效返回
都只把当前插件或当前调用标记失败；其他插件、住户存储和 boot-time 不变量继续可用。
失败插件不会自动无限重试。恢复必须是显式重试、重新启用或新版本安装。

`readiness` 至少区分：

- `ready`：active 且依赖、绑定、凭证和环境均满足；
- `degraded`：插件仍可服务已声明的子集，缺失项逐条列出；
- `blocked`：不兼容、缺必需配置、权限拒绝或迁移失败；
- `quarantined`：撤销不完整或运行时越界，所有对外入口已关闭。

状态必须带 `verifiedScope`，只说明在哪个住户、车道、操作集合与时间点验证过；不得把
“进程活着”投影成所有绑定可用。

代价：隔离会把一部分错误从崩溃变成显式降级，运维面必须展示 blocked/quarantined，
否则故障只会从停机变成静默缺能力。

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
  readonly lane: string;       // 至少支持 primary、coding
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

绑定的键是 `residentId × lane`。`main` / `subagent` 是运行角色；宿主不得从 lane 名、适配器
或凭证类型推导角色，角色只取自已经过授权的 `DispatchRequest.role`。
主 agent 挂住户生命周期和记忆，默认工具集精简；subagent 不挂住户记忆，工具按当前任务
显式开放。subagent 未指定车道时继承主请求的车道；显式换道时必须重新过绑定、权限和
工具策略校验。

`claude_oauth` 只能绑定 Claude SDK 适配器；绑定给 pi 或其他适配器必须拒绝。
`codex_oauth`、`grok_oauth` 和 `api_key` 不受这一条专属限制，但仍要满足适配器声明的
凭证类型。Claude SDK 适配器必须接受可选 `baseUrl + tokenCredentialRef`，以支持兼容
Claude 协议的网关；token 仍由凭证引用提供，不得内联。

凭证类型是 wire type，不等于宿主一定能签发。宿主只展示当前 active credential issuer
明确提供的获取类型，创建 `CredentialRef` 时记录 `issuerId`；issuer 不存在时，TUI/API
不得展示对应登录入口，外部导入的 ref 也必须能回指现役 issuer。RFC 起草时的
[pi provider 表](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
已列出 Claude、OpenAI Codex 与 xAI/Grok subscription OAuth；未来类型或外部流程仍按同一
issuer 规则接入，本协议不把登录步骤写进地基。

绑定校验发生在持久化前；失败不能覆盖上一份可用绑定。删除适配器或凭证前，宿主必须
列出受影响绑定并先解除或迁移，不能制造悬空引用。

代价：严格的凭证类型约束会拒绝一些技术上“也许能跑”的组合；这是用显式可审计的通道
语义换取少踩计费和身份边界的坑。

## 6. skill 与 MCP 都是工具能力

skill 和 MCP 统一归 `tool_capability` 插件，manifest 必须声明提供的能力、操作和副作用
等级。它们不是绕过权限契约的两条特权通道。

适配器负责翻译注入方式：

- Claude SDK：原生挂载 skills 目录和 `mcp_servers`；
- pi：skill 转为有来源标记、可裁剪的 prompt 段；
- MCP：由 mist host 收编 server 暴露的工具，再按住户、角色和任务工具策略分发。

翻译后必须保留稳定的原始 capability id、来源 plugin id、effect 和权限约束。对一个
verified scope，翻译输出的工具与已授权源操作必须逐项可逆映射：无来源工具、额外操作和
静默丢失都不允许；目标通道不支持某项时，该 capability 进入 degraded/blocked，而不是
折叠成万能工具或假装完整 ready。

代价：同一 skill 在不同适配器上的呈现不保证字节相同，只保证能力与权限语义等价；
适配器测试要覆盖每一种翻译，而不能只测源 manifest。

## 7. 版本兼容与升级迁移

安装前依次校验 `manifestSchemaVersion`、`requiresMist`、插件版本和配置 schema。
版本范围解析失败一律视为不兼容。升级使用 copy-on-write：旧插件、旧配置和旧绑定在新版本
active 前保持可恢复，新版本不得原地改写旧配置。

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
| `ACTIVATE_FAILED` | activate 失败 | 全量 rollback，未公开 |
| `MIGRATION_FAILED` | 迁移或目标 schema 校验失败 | 旧版本保持 ready |
| `DISPOSE_INCOMPLETE` | 任一资源撤销失败 | quarantined，对外入口关闭 |
| `PLUGIN_RUNTIME_FAILED` | active 插件调用抛错或超时 | 当前调用失败；按策略降级或 blocked |

诊断事件只能记录 plugin id、版本、资源 id、reason code、verified scope 和脱敏详情；
不得记录 secret env、token、OAuth 内容或完整用户输入。

## 9. 规范到判卷的对应

| RFC 规范面 | 验收区 | 主要红灯 |
|---|---|---|
| manifest、启停、host 兼容 | A | import 前拒装、停用后资源仍可达 |
| 权限、secret、skill/MCP 翻译 | B | 越权操作执行、secret 落字、翻译扩权 |
| 生命周期、事务注册、故障隔离 | C | 半注册、重复清理、注销留活线、拖死地基 |
| 住户×车道、角色、凭证约束 | D | 串房、角色混维、错凭证覆盖好绑定 |
| 版本升级、配置迁移、回滚 | E | 原地改配置、失败后 v1 不可用 |
| readiness scope、不变量与变异验证 | F | 假 ready、无稳定原因码、约束删掉仍全绿 |

## 10. 非目标

- 不实现任何具体插件或适配器；
- 不定义插件发现站、签名分发、评分、市场或自动更新服务；
- 不承诺第三方插件代码是可信沙箱；
- 不把住户人格、记忆或聊天内容放进插件包；
- 不允许插件协议改写已决的通道政策、住户连续性或权限审批点。
