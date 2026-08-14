# 决策台账

全项目唯一的拍板看板。issue 里讨论出的待决问题收编到这里追，issue 本身可以关。
三种状态：**待决**（等主笔拍板）、**挂起**（有前置条件，条件到了再启）、**已决**（带日期）。

## 待决

（空。许愿池阶段的待决已全部拍板，2026-08-14。）

## 挂起

| 编号 | 事项 | 前置条件 |
|---|---|---|
| H1 | 能力契约 schema 定稿（#2/#8/#11） | 第一里程碑垂直闭环跑通后，从真实能力反推，不凭空立 |
| H2 | 迁移路径定稿（#12：迁移信封 schema、记忆插件导入导出义务、conformance 测试集） | H1——契约成形之日，信封 schema 与关系核导出 schema 同批定稿。方向已收进 [design/migration.md](design/migration.md)；验收场景 4 与判卷 C6 重叠，已在建造 |

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

## 规矩

- 拍板只认主笔。讨论在 issue，结论落在这里，落完 issue 关门。
- 每条已决必须能指回来源（issue / PR / 文档 commit）。
- 「实证」二字只给验收清单跑出来的东西用，读过的不等于验过的。
