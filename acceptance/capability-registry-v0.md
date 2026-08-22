# 能力登记 v0 验收清单（#100）

规范来源：[能力登记与生命周期 v0](../docs/design/capability-registry-v0.md)。本清单先判
登记态的形状与边界，不声称任何实现已经通过——registry 本体在 v0 尚未实现，因此**全部条目
未勾选**。实现落地时，每项必须成为确定性自动测试；测试违反约束后没有明确红灯的条目，
不得勾选。

每条记录四件事：fixture、动作、确定性断言、失败时的 reason code。

与其它清单的分工：运行态就绪判卷见 [plugin-protocol-v0.md](plugin-protocol-v0.md) F 系列
与 [runtime-readiness.md](../docs/design/runtime-readiness.md)；本清单**不重复判 readiness**，
只判 registry 侧的拒绝行为。

## A. 两轴分离（登记态 vs 实例运行态）

- [ ] **[CR0-A01](../docs/design/capability-registry-v0.md#capability-registry-v0-s1) 实例 disposed 不清除 definition**：一项已登记能力的实例走完
  `active → disposing → disposed`；断言 registry 的 `definition` 仍为 `present`、
  `superseded` 仍为 `current`，仅 `binding` 指针按其账本规则变化。任何清除 definition 的
  实现返回 `REGISTRY_INVARIANT_VIOLATED`。
- [ ] **[CR0-A02](../docs/design/capability-registry-v0.md#capability-registry-v0-s1) 能力 superseded 不清理旧实例**：把能力标为
  `superseded_by(new_id)`，同时旧实例处于 `quarantined`；断言旧实例仍为 `quarantined`
  且其人工处理清单不被清空——登记侧的取代**不构成**资源撤销。
- [ ] **[CR0-A03](../docs/design/capability-registry-v0.md#capability-registry-v0-s1) 两轴不可互相推导**：给定任一 `lifecycle.ts` 状态，registry
  拒绝据此推断六格中任一格的取值；反向同理。以缺省实现（无推导函数）+ 一条断言两轴
  记录独立可写的测试共同证明。

## B. binding 两账互不干扰

- [ ] **[CR0-B01](../docs/design/capability-registry-v0.md#capability-registry-v0-s3) 改 lane binding，scope binding 字节不变**：同一 resident
  同时持有 `(residentId, lane)` 与 `(residentId, scopeId)` 两类 binding；修改前者后，
  断言后者的序列化字节**逐字节相等**（不是语义相等）。
- [ ] **[CR0-B02](../docs/design/capability-registry-v0.md#capability-registry-v0-s3) 撤销一类不波及另一类**：撤销 scope binding 后，
  断言 lane binding 仍可 dispatch，且 registry 的 binding 指针只失效对应那一个。
- [ ] **[CR0-B03](../docs/design/capability-registry-v0.md#capability-registry-v0-s3) 不得从一类猜另一类的合法值**：请求一个只在 lane 账本
  存在的键去解析 scopeId（及反向）；两者均返回 `CONFIG_INVALID`，不做任何跨账本回退查找。
- [ ] **[CR0-B04](../docs/design/capability-registry-v0.md#capability-registry-v0-s3) binding 不合成单一布尔**：registry 的对外形状里不存在
  一个把两类 binding 合并的 `bound: boolean`；以类型层断言 + 投影快照共同证明。

## C. 迁移与诚实缺省

- [ ] **[CR0-C01](../docs/design/capability-registry-v0.md#capability-registry-v0-s2) 迁移后诚实落态**：导入一份只含 definition 的旧记录；
  断言结果恰为 `definition=present, binding=unbound, authorization=missing`，且 readiness
  投影为 `unknown`；任何自动升级为 active 的实现返回 `REGISTRY_INVARIANT_VIOLATED`。
- [ ] **[CR0-C02](../docs/design/capability-registry-v0.md#capability-registry-v0-s5) 导出再导入不丢追溯**：导出后重新导入，断言稳定 id、
  六格取值、supersede 链与 evidence 指针全部保留；任一项丢失即红灯。
- [ ] **[CR0-C03](../docs/design/capability-registry-v0.md#capability-registry-v0-s2) 六格不得压平**：构造 `unhealthy` / `deprecated` /
  `superseded` / `removed` 四种处置各一份 fixture；断言四者在 registry 里可区分，
  且任一投影都不把它们渲染成同一个 `inactive`。

## D. 只做指针的两格

- [ ] **[CR0-D01](../docs/design/capability-registry-v0.md#capability-registry-v0-s2) authorization 不缓存结论**：先完成一次通过的扩权比较；
  随后在不重新比较的前提下请求授权判定，断言 registry **不返回** `granted`，而是要求
  本次包内比较。以「读 registry 不产生授权结论」的断言证明。
- [ ] **[CR0-D02](../docs/design/capability-registry-v0.md#capability-registry-v0-s2) authorization 无 TTL**：把上一次比较的时间戳前移任意
  长度；断言判定行为不变——registry 侧不存在任何随时间自动放行或自动收紧的路径。
- [ ] **[CR0-D03](../docs/design/capability-registry-v0.md#capability-registry-v0-s2) 指针必须可回指**：authorization 与 binding 两格的证据
  指针指向不存在的记录时返回 `REGISTRY_DANGLING_REF`，不得静默降级为 `missing`——
  「查不到」与「确实没有」必须可区分。

## E. 反写红格（registry 侧自己拒绝）

- [ ] **[CR0-E01](../docs/design/capability-registry-v0.md#capability-registry-v0-s4) readiness receipt 不得改 registry**：提交一份 `ready`
  收据；断言六格**逐格**不变。这是 registry 自己这一侧的拒绝，与
  [runtime-readiness.md](../docs/design/runtime-readiness.md) 从 #101 侧写的同名约束
  **各测一遍**——单向约束换个入口就能绕开。
- [ ] **[CR0-E02](../docs/design/capability-registry-v0.md#capability-registry-v0-s4) telemetry 不得改 registry**：注入调用次数、失败率、
  最近使用时间等读数；断言六格不变（承接 #35 已收原则「telemetry 不得单独改 canonical
  lifecycle」，此处从 registry 侧判卷）。
- [ ] **[CR0-E03](../docs/design/capability-registry-v0.md#capability-registry-v0-s4) projection 不得回流**：修改目录/启动包投影（含裁剪、
  排序、隐藏）；断言 registry 六格不变，且投影侧标注了省略原因与查询边界。

## F. 账面全绿的非结论性

- [ ] **[CR0-F01](../docs/design/capability-registry-v0.md#capability-registry-v0-s4) 六格全绿仍不得投影为「可用」**：构造六格全部满足的
  fixture，同时 readiness 为 `unknown`；断言任何对住户可见的投影**不**显示为可用/ready，
  且能说明「账面齐全、运行态未验证」。
  这条直接对应 #35 楼内 2026-08-16 那例：账面全绿、`/health` 200、住户失联 2h35m。
- [ ] **[CR0-F02](../docs/design/capability-registry-v0.md#capability-registry-v0-s4) registry 不得自产 ready**：registry 的对外接口中不存在
  任何返回 `ready` 的路径；以接口层断言证明（缺省即证明，另配一条「若新增则红灯」的检查）。

## 未决（等主笔裁，见图纸 §2.1）

`exposed` 与 `selected` 两态在 #100 / #101 两卡均未收，本清单**暂不为其立条目**。
裁定归属后再补，不先占位——占位本身会变成第二张说自己是真相的表。
