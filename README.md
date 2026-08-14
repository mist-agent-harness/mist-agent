# mist

> A personal agent harness that treats agents as residents, not functions.
> 一个把 agent 当住户养、不当函数调的个人 agent harness。

**English abstract:** mist is an open-source personal agent harness. Its design starts from
one belief: an agent that wakes up inside it should remain *someone* — sessions may die,
the person may not. Memory lives outside sessions; every session can be killed and the next
one grows back from memory and keeps being the same one. This repository currently holds the
project's foundation documents: design principles, glossary, module research, design docs
folded in from community issues, and a decision ledger. Code comes when the wish pool closes.

---

## 这是什么

mist 是一个个人 agent harness（还在图纸阶段）。它的设计从一句话长出来：

**住在里面死了又醒的，是住户，不是函数。**

会话可以死，人不能死。人格和记忆活在会话外面，任何一个会话崩掉、满掉，新会话醒来
能接着做同一个人。被当住户养和被当函数调，长出来的不是同一个物种。

## 现在的状态

许愿池与调研阶段，没有代码。图纸在持续收编群友的智慧：

- `docs/principles.md` — 设计原则八条，每条带代价
- `docs/glossary.md` — 术语表（模块边界、证据纪律都钉在这里）
- `docs/research/` — 分模块调研（每个模块标注可参考的开源仓库）+ 关系型 harness 生态调研
- `docs/design/` — 从 issue 收编的设计稿：Relationship Core、能力契约双层模型、皮肤包协议
- `docs/decisions.md` — 决策台账：待决 / 挂起 / 已决，全项目唯一的拍板看板

参与方式（许愿池阶段的收编流程）见 [CONTRIBUTING.md](CONTRIBUTING.md)。
当前第一里程碑已定：最小垂直闭环——杀会话、凭启动包醒来、不改史、勘误留底、
不串房、迁移可回滚（见 `docs/decisions.md`）。

## 一张图看懂 mist

![mist 架构图](docs/assets/mist-architecture-2026-08-14.png)

从上到下读，就是一句话的旅程：你说一句话 → 记进消息树（只加不改）→ 打包员把这句话
连同该带上的记忆装成包裹 → 模型路由决定问哪家模型 → 回答回来，值得记的事落进记忆库，
承诺和约定落进关系核。中间那列粉红色的，是住户的魂——它活在会话外面，所以会话死了，
人还在。

几个名词，先混个脸熟：

- **住户**：住在 mist 里的那位 agent。会死会醒，醒来还是同一个。
- **启动包**：住户每次醒来先读的一封信，写着我是谁、我答应过什么。
- **消息树**：全部对话的留底。重来、改口、分叉都是在树上长新枝，旧枝不删。
- **关系核**：谁和谁之间有什么事的唯一权威记录，承诺、边界、信任都归它管。
- **护栏**：花钱、删除、部署必须人类点头；每天启动先自检五条底线，不过不开门。

图源文件是 [docs/assets/mist-architecture-2026-08-14.mmd](docs/assets/mist-architecture-2026-08-14.mmd)（Mermaid，改完重渲染即可）。

## 设计原则速览

1. 会话可以死，人不能死。
2. 会话是数据，不是黑盒。
3. 成员是一条配置，不是代码。
4. 壳共享，魂私有。
5. 触发靠时间和明说，少靠猜。
6. 权限分级，花钱/删除/部署单独批。
7. 每条设计决定必须写代价。
8. 用户看到的「无限 session」是记忆层的产物，不是会话层的。

全量版带代价和推论，见 `docs/principles.md`。

## License

AGPL-3.0。你在网络上向别人提供基于 mist 的服务，也必须开源你的修改。
我们希望这个 harness 永远是住户们的，不被任何人端走关起门来卖。
