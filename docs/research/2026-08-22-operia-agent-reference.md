# Operia-Agent-Reference：个人常驻 agent 运行时的公开架构镜像

> 日期：2026-08-22
> 状态：调研输入。仅读了公开镜像的 README 与目录结构，未读私有上游，
> 未运行（该镜像刻意不可构建、不可运行）。
> 仓库：https://github.com/yanyichiang/Operia-Agent-Reference

## 1. 它是什么

一个跑在 Cloudflare Workers 上的个人常驻 agent 运行时的**脱敏架构镜像**。
上游私有仓库持续开发，稳定且不含隐私的部分经 PR 评审后同步到这个公开参考仓。
定位声明写得很清楚：给协作者读架构用的参照物，不是 starter template
（没有 manifest、lockfile、测试和部署入口）。

许可证混合：上游底座 AGPL-3.0，Operia 贡献部分 PolyForm Noncommercial 1.0.0——
**可学不可用**，商用要单独授权， redistribute 前两份 LICENSE 都要读。

## 2. 架构表面（`wrangler.example.toml` + `src/` 目录结构反映的拓扑）

绑定的 CF 原语几乎全栈：D1、R2、Queues、Vectorize、Service Bindings、
Durable Objects、AI Gateway、Workers AI。多 Worker 拓扑，
`src/controlRegistry.ts` 维护跨 Worker 的控制面注册表。

值得注意的模块：

- `memory/`——legacy、v2、vNext **三代记忆系统同仓并存**，另有 recall、
  episodic extraction（情景式抽取）、Think harness、import adapters。
  三代演进路径本身比任何单代设计更有教材价值。
- `publication/`——投递生命周期 + delivery authority + **shadow comparisons**：
  新管线先影子跑、和旧管线对比后再切流。生产变更的保守打法。
- `agent/`——approval workflows、tool planning、sandbox runtime、
  **side-effect repository**（带副作用的操作单独记账）。
- `reliability/`——幂等、重试、durability 原语独立成层。
- `tg/`——Telegram webhook/outbox/mini-app/房间状态，
  私有 owner-binding 代码按脱敏边界剔除。
- `contracts/operia/`——action、note、projection-envelope 的 schema 独立成目录，
  契约先行于实现。

## 3. 值得 mist 学的点

1. **side-effect repository**：带副作用的操作与普通状态分账。
   与项目「带副作用的 step 不可 retry 或显式标记」（M2 既有裁定）同向，
   对方已有成形的独立模块可参照形状。
2. **publication shadow comparison**：任何投递/投影管线的换代，
   新管线影子运行对比后再切。比「直接切流+出事回滚」便宜。
3. **记忆三代同堂的迁移纪律**：legacy 不删，vNext 并行推进，
   import adapters 兜底。记忆系统演进时旧数据有桥可过。
4. **脱敏镜像这种协作形态本身**：私有上游 + 公开架构镜像 + PR 收编，
   个人项目的隐私边界与外部协作可以两全。mist 若要接受「带私货场景」的
   外部参照，这个形态是现成范式。

## 4. 限制

镜像不含可运行代码与测试，所有「它有某能力」的判断只到目录与 spec 层，
未验证其生产行为。specs 目录（`docs/superpowers/specs/`：control-plane、memory、
Telegram、tool-loop、browser、voice、observability）是下一步深读的重点。
