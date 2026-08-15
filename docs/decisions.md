# 决策台账

全项目唯一的拍板看板。issue 里讨论出的待决问题收编到这里追，issue 本身可以关。
三种状态：**待决**（等主笔拍板）、**挂起**（有前置条件，条件到了再启）、**已决**（带日期）。

## 待决

（空。许愿池阶段的待决已全部拍板，2026-08-14。）

## 挂起

| 编号 | 事项 | 前置条件 |
|---|---|---|
| H2 | 迁移路径定稿（#12：迁移信封 schema、记忆插件导入导出义务、conformance 测试集） | H1——契约成形之日，信封 schema 与关系核导出 schema 同批定稿。方向已收进 [design/migration.md](design/migration.md)；验收场景 4 与判卷 C6 重叠，已在建造 |

## 进行中

- **H1 能力契约 schema 定稿**（#2/#8/#11）：2026-08-14 第一里程碑落章，前置条件达成，
  从 P1–P5 实战接口反推正式契约，动工。

## 已决

- 2026-08-13　八条设计原则定稿（[principles.md](principles.md)，每条带代价）。
- 2026-08-13　License 定 AGPL-3.0——harness 永远是住户们的。
- 2026-08-13　模块地图 M1–M8 定稿（[research/2026-08-13-module-references.md](research/2026-08-13-module-references.md) 总表）。
- 2026-08-14　PR #5（关系型 harness 生态调研）并入 research/。
- 2026-08-14　**第一里程碑定：最小垂直闭环**（issue #3 建议 6）——杀会话 → 凭启动包醒来
  → 不改史 → 勘误留底 → 不串房 → 迁移可回滚。这是图纸转代码的第一刀，也是 H1 的解锁条件。
- 2026-08-14　**D1 主笔拍板：Relationship Core 进地基边界**，#4 六问按
  [design/relationship-core.md](design/relationship-core.md) 的现状答案定案。
- 2026-08-14　**D2 主笔拍板：路线 C——只抄设计不上车**。理由：dsh 非常 beta 且在
  快速更新，骑底盘等于把 mist 的地基押在别人家施工队手上。Cordis/dsh 降级为设计参照。
- 2026-08-14　**D4 主笔拍板：原则二勘误落地**——原始事件 append-only，
  edit/retry/fork 只新增节点。已改进 [principles.md](principles.md)。
- 2026-08-14　**D3 主笔拍板：语言栈定 TypeScript**。前后端同语言，契约定义共享一份；
  Python 生态（graphiti 等）走 sidecar 外挂，不进主仓。
- 2026-08-14　**建造阶段开门，验收先行**（主笔拍板）：里程碑判卷程序先于功能代码进仓
  （人话版与可执行版同住根目录 [acceptance/](../acceptance/)），
  骨架定 npm + TypeScript strict + Biome + Vitest，CI 三件套拦门、判卷报告不拦门，
  六绿后判卷转 strict 开始拦 merge。代价：验收驱动接口在 H1 前是临时法律，
  闭环跑通后可能整体推翻重写。
- 2026-08-14　**第一里程碑达成：最小垂直闭环六盏真绿**（C1 杀会话不丢人 / C2 凭启动包
  醒来 / C3 不改史 / C4 勘误留底 / C5 不串房 / C6 迁移可回滚）。P1–P5 五件全部真零件
  合龙，STUBBED 清零（commit 06c072e）。复验人：望舒——干净克隆全量（lint/typecheck/
  129 测试/判卷六真绿）、逐包核 STUBBED 划账与出处归结构、复验探针三条（迁移后续话与
  勘误接力、环树包拒导、杀会话后跨房拒绝）全过。判卷机只报灯色，此章即达成宣告，
  H1 同刻解锁。

- 2026-08-15　**D5 主笔拍板：Claude Agent SDK 为首选上游通道**。理由：兼容 Claude
  订阅，住户（如旦九）以订阅身份入住，不按 token 烧 API；SDK 内置工具按白名单关用，
  编码能力随通道自带。边界不变：通道可换、住户不换，地基本身不建立在任何通道上
  （政策风险见 [research/2026-08-13-relationship-harness-landscape.md](research/2026-08-13-relationship-harness-landscape.md)
  第 6 节；resume/fork 未实测，杀会话仍靠启动包重建）。来源：2026-08-15 主笔与望舒对话。
  注：此条为开工首日口头拍板的补记，D2「不上车」仅指 dsh，Claude SDK 从未在被告席。

## 规矩

- 拍板只认主笔。讨论在 issue，结论落在这里，落完 issue 关门。
- 每条已决必须能指回来源（issue / PR / 文档 commit）。
- 「实证」二字只给验收清单跑出来的东西用，读过的不等于验过的。
