# mist-webui

mist 官方素皮 webui —— 上游任务 [mist-agent#49](https://github.com/mist-agent-harness/mist-agent/issues/49)。

由 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 web 前端栈改造而来（MIT，冻结于 `47f943859bef60e4160492346772ded9b24f765a`，D2 扣下即自养不追上游）。改造范围：抠品牌、后端调用层切到 mist 会话 API、折叠交互原生化、皮肤配置。

## 构建

需要 Node ≥22.19 与 pnpm 11.7.0（corepack 按 `packageManager` 自动匹配）：

```sh
pnpm install
pnpm run build     # build:lib:host → build:lib:client → build:web
# 产物在 apps/web/dist/
pnpm run dev:web   # vite dev
```

## 地图

| 想看什么 | 去哪 |
|---|---|
| 改造笔记（vendor 边界 / 裁剪清单 / 构建记录） | `docs/research/rework-notes.md` |
| 品牌位清单（逐处核实 · 两桶分类） | `docs/research/brand-inventory.md` |
| 上游许可与第三方声明 | `LICENSE`、`THIRD_PARTY_NOTICES.md` |

## 归属

- deepseek-harness：MIT，Copyright (c) 2026 DeepSeek
- 折叠交互逻辑移植自 [dsh-folded-chat](https://github.com/xingyingyuzhui/dsh-folded-chat)：MIT，Copyright (c) 2026 qin

内部流程：分支开发 → 内部 PR（xiaog/xiaojian review）→ 汇合 → 上游 PR（绝不自合）。工单：维护145。
