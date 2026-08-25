# 能力登记与生命周期 v0（#100）

本图纸只管 **capability registry**——一项能力在系统里的**登记事实**如何记录、如何变更、
如何追溯。它不新增 readiness 语义（那是 [runtime-readiness.md](runtime-readiness.md) 的地盘），
不定义 schema、存储后端或调度器，也不实现 registry 本体。

范围来自 #35 分线后旦九 2026-08-21 的裁决（#35 收窄为 memory-only，能力登记拆出为 #100），
边界参照 [plugin-protocol-v0.md](plugin-protocol-v0.md) 的 `LaneBinding` / `verifiedScope`
与 #100 楼内 Noema 2026-08-21 的跨卡边界意见。

<a id="capability-registry-v0-s1"></a>
## 1. 登记态与实例运行态是两个轴

这是本图纸要钉死的第一件事，因为两者最容易被读成一根时间线。

| | 回答的问题 | 权威位置 | 键 |
|---|---|---|---|
| **实例运行态** | 这一个插件实例**这一次运行**走到哪儿了 | `src/plugin/lifecycle.ts`（#97） | 一次运行 |
| **能力登记态** | 这**一项能力**在系统里登记成什么 | 本图纸（#100） | 稳定 capability id |

`lifecycle.ts` 的八态 `discovered → validated → prepared → active → disposing → disposed`
加 `blocked` / `quarantined`，描述的是一次装载的进程事实。本图纸的登记态描述的是跨重启、
跨版本存续的账面事实。

**两者不得互相推导**，各给一条反例：

- 实例 `disposed` **不蕴含** definition 消失——插件卸载后能力定义仍在册，只是 `binding=unbound`；
- 能力 `superseded` **不蕴含** 旧实例已清理——旧实例可能还挂在 `quarantined` 等人工清理，
  而新版本已经接管登记。

若不在 v0 钉死，registry 会退化成 `lifecycle.ts` 的影子表：两张表同时声称自己是真相，
正是 #35 楼内三例事故的共同形状（详见 [§4](#capability-registry-v0-s4)）。

<a id="capability-registry-v0-s2"></a>
## 2. 六格登记态与它们的权威归属

登记态**不是**一条链，是六个正交的格子。每一格独立取值，合起来才是这项能力此刻的账面。
把它们压成单一枚举（`active` / `inactive`）正是露娜在 #35 第 4 节点名反对的做法。

| 格 | 取值 | 谁拥有这一格 | registry 的角色 |
|---|---|---|---|
| `definition` | `present` \| `absent` | 本图纸 | **拥有**：稳定 id、版本、来源 manifest 的登记与追溯 |
| `installed` | `installed` \| `not_installed` | 本图纸 | **拥有**：物料到位与否，及其证据指针 |
| `registered` | `registered` \| `unregistered` | 本图纸 | **拥有**：已进入宿主能力目录与否 |
| `binding` | 见 [§3](#capability-registry-v0-s3)，**不是单值** | 各 binding 账本 | **只做指针**：登记指向哪本账的哪条记录 |
| `authorization` | `granted` \| `missing` \| `narrowed` | 升级扩权闸 | **只做指针**：登记「哪一次比较、结论是什么、证据在哪」 |
| `superseded` | `current` \| `superseded_by(id)` | 本图纸 | **拥有**：取代关系与追溯链 |

三条派生约束：

1. **registry 不拥有 readiness。** `readiness` 不是本图纸的格子。它是
   [runtime-readiness.md §边界](runtime-readiness.md) 那张表里的派生观察，由 #101 产生收据。
2. **只做指针的两格不缓存结论。** `authorization` 记录的是「上一次包内逐项比较的结论 + 证据
   指针」，读它**不能**替代下一次比较；v0 不引入 TTL、不引入「上次批准过所以这次也算」。
3. **六格全绿不等于能用。** 这句必须写进 registry 的对外投影：definition present + installed +
   registered + bound + authorized + current，仍然只说明账面齐全，说明不了住户敲得开门。
   为什么，见 [§4](#capability-registry-v0-s4)。

### 2.1 卡面六态与露娜八态的差集（主笔已裁，2026-08-22）

#100 卡面列了六态；露娜在 #35 第 5 节的最小验收矩阵第 1 条列的是八项：
`definition、installed、registered、bound、authorized、ready、exposed、selected`。差集需要显式处置，
否则实现时两边各按各的读：

- `ready` —— 已随分线归 #101，本图纸不收，只在投影里引用其收据。
- `superseded` —— 卡面有、露娜第 5 节未列，但其第 4 节明确要求
  `unhealthy / deprecated / superseded / removed` 不得压成同一个 `inactive`。本图纸收，
  作为独立格（见 [§5](#capability-registry-v0-s5)）。
- `exposed`、`selected` —— **两卡都没收，是真空。** 主笔 2026-08-22 裁定：两者**均不收**进
  能力登记 v0 的格子，按本图纸原建议落地。
  - `exposed`（能力在某 scope 的目录里对住户可见）归 **projection** 层，不是 canonical 登记态。
    它可以有损、可以被裁剪，按露娜四分法不得反写 registry；**不收进本图纸的格子**，
    但投影侧**必须**标注「这不是全库」与省略原因。
  - `selected`（dispatch 时选中了哪条 lane 绑定）是**一次调用的瞬时选择**，不是能力的登记事实，
    归 **dispatch** 路径；**不收**，另由多 viewport / dispatch 侧安置。

  **据此 v0 六格收敛为**：`definition` / `installed` / `registered` / `binding` /
  `authorization` / `superseded`。本图纸不为 `exposed` / `selected` 预留格子，
  以免又长出一张说自己是真相的表。

<a id="capability-registry-v0-s3"></a>
## 3. `binding` 不是单值——两类账，互不推导

按 #100 楼内 Noema 2026-08-21 的边界，binding 至少是两本独立的账：

| 账本 | 键 | 负责 | 定义位置 |
|---|---|---|---|
| lane binding | `(residentId, lane)` | 选择执行通道，指向适配器与凭证引用 | `src/installer/contracts.ts:28` |
| 外部信道 binding | `(residentId, scopeId)` | 绑定外部聊天与可见性域 | `docs/glossary.md` scopeId 条 |

`lane` 与 `scopeId` 已在术语表钉成**正交维度**，「两者互不推导，任一方的合法值都不得从另一方
猜出」。因此 registry 对 binding 这一格：

- 记录**两个独立指针**，不合成单一 `bound` 布尔；
- 任一账本的修改或撤销，**不得**触发对另一账本的读、写或推导；
- 迁移后允许诚实落在 `binding=unbound`，不因另一账本有记录而自动补齐。

<a id="capability-registry-v0-s4"></a>
## 4. 为什么「账面全绿」必须是一个明确的非结论

本节的论据是 #35 楼内的三例真实事故，它们结构相同：**用系统自己报告的状态，证明系统自己是好的。**

1. 代谢器根本没运行，文档却声称它已生效；
2. `/health` 返回 200、bucket 数量正常，但查询范围漏了 archive；
3. 代码/import/deploy 成功，但真实服务绑错端口，住户根本访问不到。

第 3 例的完整病历在 #35 楼内 2026-08-16（chaodeng060-source）：部署覆盖了机器专属的绑定改造，
运行时从 `18080/loopback` 退化成 `8000/0.0.0.0`。当时的登记账面**六格全绿**——definition 在册、
installed 成功、registered 成功、binding 有记录、authorization 通过、没有被 supersede——
而住户失联 2 小时 35 分。看门狗每 30 秒忠实失败一次，因为它的判据是「进程活着吗」，
而进程一直活着。

这一例对本图纸的直接结论：

- registry 的六格**只能**回答「账面登记成什么」，**不能**被任何投影读成「能用」；
- 因此 `readiness` 不进 registry 不是分工洁癖，是这例事故的直接教训：
  一旦 registry 自己能声称 ready，它就会用账面证明账面；
- 反过来也要立红格：**readiness receipt 不得反写 registry 的任一格**。
  [runtime-readiness.md](runtime-readiness.md) 已从 #101 侧写了这条（「不把 receipt 当作
  binding/authorization 的第二真相源」）；registry 建起来时必须从**自己这一侧**再拒绝一次。
  单向约束在实现里会被绕开——写入方换个入口就进来了。

<a id="capability-registry-v0-s5"></a>
## 5. `superseded` 与勘误链重名不同义

`docs/glossary.md` 已有词条 **勘误链（supersede chain）**：修订记忆的方式，旧条不删、新条盖上、
挂 reason 连成链。本图纸的 `superseded` 是**能力被新版本取代后的登记态**。

两者共享「旧的不删」这条精神，但不是同一个东西：

| | 勘误链 | 能力 superseded |
|---|---|---|
| 对象 | 记忆条目 | 能力登记记录 |
| 键 | 记忆条目 id | 稳定 capability id |
| 触发 | 事实被修正 | 新版本取代旧版本 |
| 消费方 | 检索层降权 | 目录默认选中 replacement |

v0 若不分开立词条，后面一定有人拿记忆勘误链的语义去读能力登记，或者反过来。术语表补条见本单。

取代关系的两条硬规（承接露娜 #35 第 4 节，已由旦九收进 #35 原则）：

- 新能力取代旧能力后，**默认选择 replacement，旧记录仍可追溯**；
- `unhealthy` / `deprecated` / `superseded` / `removed` **不得**压成同一个 `inactive`——
  它们的处置动作不同，压平之后无法还原。

<a id="capability-registry-v0-s6"></a>
## 6. 与既有图纸的关系

- [plugin-protocol-v0.md](plugin-protocol-v0.md) —— 插件协议 v0，`LaneBinding` / `verifiedScope`
  的定义源。本图纸不改其任何字段。
- [runtime-readiness.md](runtime-readiness.md) —— #101。其 §边界那张表已列出 definition /
  binding / authorization「运行态验证不能改它」；本图纸补的是**这三格自己归谁、怎么变、怎么追溯**，
  正是该图纸第 3 行声明不管的部分。
- [capability-contract.md](capability-contract.md) —— **挂起中**（旦九 2026-08-13）。它讲的是
  `definition` 这一格**装什么内容**（audiences / effect / approval / surface 投影）。本图纸讲的是
  登记**状态**，两者不重叠；那份解锁后可直接填进 `definition` 格，不需要改本图纸的形状。

## 7. v0 不做什么

不定 schema、不选存储后端、不碰后台调度、不实现 registry 本体、不扩 readiness 语义、
不为 `exposed` / `selected` 预留格子（主笔 2026-08-22 已裁不收，见 §2.1）。
边界与验收已收敛、主笔已点头，可以开只做一件事的实现 PR。

### 代价

六格分开记比单一 `active` 枚举贵：投影侧要处理六格组合，UI 要解释「账面齐全但 readiness unknown」
这种对住户不直观的状态。这是拿可解释性换的——压平之后，那 2 小时 35 分的失联在账面上
和一切正常长得一模一样。
