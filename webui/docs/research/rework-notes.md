# mist-webui 改造笔记（单A · mist-agent#49）

边摸边记。品牌位清单见同目录 `brand-inventory.md`（小面 · 对冻结树逐处核实）。

## 来源与归属（桶B · 必留）

| 上游 | 冻结点 | 许可 | 版权 |
|---|---|---|---|
| deepseek-ai/deepseek-harness | `47f943859bef60e4160492346772ded9b24f765a` | MIT | Copyright (c) 2026 DeepSeek |
| xingyingyuzhui/dsh-folded-chat（折叠交互逻辑移植来源） | `dbc0e4c5890240e7cd72a88a3b20c116435e2017` | MIT | Copyright (c) 2026 qin |

- 根目录 `LICENSE`、`THIRD_PARTY_NOTICES.md` 原样保留。
- dsh-folded-chat 的 MIT 许可证全文收在同目录 `dsh-folded-chat.LICENSE`（归属桶正本，扫描器勿入清洗桶）。
- `@deepseek-ai/*` 包命名空间保留（内部命名空间按归属处理，不属产品面品牌残留；见 #49 楼内裁定）。
- D2 扣下即自养：不追上游更新。

## vendor 边界（实际拿了什么 · 构建绿灯后的终态）

拿：`packages/`（完整）、`vendor/`（cosmokit、schemastery，pnpm overrides 必需）、`native/landlock-run`（workspace 成员，`sandbox-local` 直接依赖）、`patches/`（node-pty）、`apps/web`、根构建配置（`tsconfig*.json`、`tsdown.config.ts`、`vitest*` 三件、`knip.json`）、`pnpm-lock.yaml`、`LICENSE`、`THIRD_PARTY_NOTICES.md`。

没拿：`apps/cli`（dsh 命令行入口，mist 用不上）、`website/`、`docs/`、根 `examples/`、`python/`、`assets/`、`scripts/`（上游 CI/文档工具链 2.1M，与产品构建无关）。

## 骨架期教训（两跤 · 都是「裁早了」）

1. 裁 `native/landlock-run` → `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`（sandbox-local 依赖它）→ 恢复。
2. 裁 `packages/examples/` → 同错（`packages/sdk/server` 依赖 agent-spine-demo）→ 恢复。

**结论：骨架期零裁剪。** workspace 全员必须可解析；一切裁剪等 knip 全图分析 + 单独 PR。

## 裁剪清单（实际删的 · 全部与被裁的 scripts/ 相关）

| 删了什么 | 为什么 | 验证 |
|---|---|---|
| 5 个 spec：core/agent/verify-export-jsdoc、core/session/gen-persistence-catalog、core/tools/gen-tool-catalog、examples/agent-spine-demo/gen-config-catalog、typert/generator/cordis-catalog | 它们测的是根 `scripts/` 目录的目录学工具（没拿），import `../../../../scripts/*.ts` 直接失败 | `grep -rln "\.\./scripts/" packages apps vendor` 全仓仅此 5 处，一次拔净 |

## 对上游根配置的修改

| 文件 | 改动 | 为什么 |
|---|---|---|
| `pnpm-workspace.yaml` | 成员裁到 `vendor/* packages/*/* native/landlock-run(+packages/*) apps/*`；其余原样 | 掉落的成员目录没拿 |
| `package.json`（根） | scripts 从 ~140 条裁到 10 条（build/dev/typecheck/test 线）；`workspaces` 同步裁；去掉 `postinstall`（lefthook 不装） | 上游脚本 zoo 依赖 `scripts/` 目录，与产品构建无关 |
| `tsconfig.host.json` | 去掉根 examples/website 的 include、`./apps/cli` 的 reference；`packages/examples` 与 landlock 的 references 保留 | 只删没拿的，拿了的都留 |

## 构建绿灯记录（实查）

- `pnpm install --no-frozen-lockfile`：29.9s，lockfile 供应链检查通过（安装时报 1203 entries；**提交态 lock 为 1101**——裁掉的 workspace importer 被 prune，差额即被裁成员的条目。小g审计 #PR1 指出后修正）
- lefthook 包自带 postinstall 会在仓根生成全注释样例 `lefthook.yml`（小g审计发现 骨架期误入库）——已删并进 .gitignore；`clean` 脚本原指向未 vendor 的 scripts/clean.ts 已改为 `git clean -fdX` 形式
- `pnpm run build`（build:lib:host → build:lib:client → build:web）：**exit 0**，1m38s，`apps/web/dist/` 产出 index.html + assets + favicon.svg + manifest.webmanifest
- 环境：Node 22.21.1（独立安装，不动系统 Node 20）+ pnpm 11.7.0（corepack）
- 尚未接：`pnpm test`（全仓 vitest）、lint 工具链、CI——骨架 PR 不含，下一步单独接（小g门④）

## 运行时依赖闭包（实查 · 47f9438）

从 `@deepseek-ai/dsh-client-web` 出发 dependencies+peerDependencies 闭包 = **58 个 workspace 包**（client 树 12 + host 侧 46——web 壳的 Host 半边把 agent/llm/session/sandbox 等拽进来）。外部运行时依赖 27 个（react、zustand、shiki、katex、micromark 系、ws、zod 等）。devDependencies 另算（含 test-support 4 包）。

## 构建环境

- Node ≥22.19（上游 engines；本仓开发用 22.21.1），pnpm 11.7.0（corepack，`packageManager` 钉住）
- 构建线：`build:lib:host` → `build:lib:client`（tsc -b + tsdown 双 face）→ `build:web`（vite）

## 调用层改动（连接层 · 待续）

- 替换缝：`AbstractApiClient/IApiClient` 之后挂 MistApiClient，UI 不感知。
- P0 方法面与事件外壳按 #49 楼内汇总稿第五节。
- （实施后逐条补记。）

## 皮肤配置层（skin.config.json · #49「界面长相由皮肤配置文件说了算」）

- 真源：`packages/client/web/skin.config.json` 三段——`palette`（雾灰蓝 11 档，含上游原样键名 `700-delete`）、`fonts`（sans/mono 两栈，初值 = base.css `:root` 默认，视觉零变化、接管所有权）、`wordmark`（字标文本）。
- 生成器：`packages/client/web/scripts/build-skin.mjs`（零依赖 node 脚本，配置形状非法 fail loud），产出 `src/mist-skin.css` + `src/skin-wordmark.ts`。产物随仓提交（lane 测试 import boot.tsx 不依赖先构建）；`--check` 只校验不落盘，漂移非零退出。palette 有全集门（大审 P2）：档位必须恰好覆盖 design-platform.css 实读的上游色阶全集——缺档会静默回退成上游品牌色值、多档是无消费方的配置幻觉，缺/多都 fail loud 报具体 stop；`--config` 是负测缝（校验先于写盘）。
- 构建钩：根 `build` / `dev:web` 入口先跑 `build:skin`；boot.tsx 引入点不变（base.css 之后层叠取胜）。
- 字标消费：AppRoot loading 皮改读生成的 `SKIN_WORDMARK` 常量；既有契约测试（app-root 的 getByText mist）不动。
- 契约测试：`tests/skin-config.client.spec.ts` 按盘面对账——产物与配置逐段一致才绿，手改产物或改配置不重新生成都会红；另有两条负测用 `--config` 篡改配置真跑生成器，钉死全集门本身（缺档/多档都非零退出且报具体 stop）。
- 边界（留大审裁决）：BrandWordmark SVG 内 baked 的 mist 字形（ui-primitives 跨包，真品牌美术落地时随字稿一起换）、index.html/manifest 静态字标（浏览器 chrome，不属界面反射面）不在本机制内。

## 功能清单（验收手测 · 小扫 2026-08-17 集成后打勾）

- [x] 聊天主视图（发送/接收/流式）
- [x] 思考折叠（两层：过程/工具调用）
- [x] 工具卡片
- [x] 设置页
- [x] 皮肤配置改色改字生效
- [x] 会话全程走 mist API 无 pi 直连

### 手测留痕（项目 | 环境 | 结果）

| 项目 | 环境 | 结果 |
|---|---|---|
| 聊天主视图（发送/接收/流式） | LA 本机 4700 · curl /api + headless chrome DOM | 通过：session.create→prompt→history 全通；history 22 条事件含 assistant/chunk 流式块（reasoning/text/tool-call delta）、user/message、assistant/message(append)；UI 有发送钮/模型选择器/会话列表 |
| 思考折叠（过程/工具调用） | LA 4700 · headless chrome DOM + history 结构 | 通过（结构层）：DOM 含 fold-group/collapse/expand 类；history 为 step/start→reasoning chunks→tool/call→step/end 分层，fold-groups.ts 分组前提成立。展开/收起交互烟雾已由獭獭验（零 pageerror），本机未做点击级点验 |
| 工具卡片 | LA 4700 · history 事件 | 通过（数据层）：tool/call + tool/result 事件齐（callId 关联），工具卡片数据源就位 |
| 设置页 | LA 4700 · /api/settings.describe | 通过（API）：返回 writable ui-onboarding namespace + welcomeNoticeVersion 2026-08-17.1 |
| 皮肤配置改色改字生效 | LA 4700 · DOM + manifest/favicon | 通过：title=「mist」、manifest name/short_name=mist、favicon=mist 图形（非鱼标）、workspace 标签「Mist」、onboarding 文案「mist 0.1 …」；皮肤覆盖层已进 index CSS（dsw-static-deepseek-* 全阶重定义） |
| 会话全程走 mist API 无 pi 直连 | LA 4700 · curl /api/* | 通过：/api 由 mist mock 承接（host.describe=0.1.0-mock、cwd=/mist、无 dsh 品牌）；P1 方法 session.rename 返回 internal「not implemented by Mist webui v0」（契约合规）；坏 payload 返回 bad-request + zod issues |

| 真机点验（验收官阿蕉） | iPhone Safari · https://mist.jacqueandbijou.cc（token→cookie 门）· main 98fffc3 现烤 dist | 通过：素皮开机→选既有工作区（mist）→建会话发消息→Think→工具卡片（mist_contract_probe p0→contract-ok）→回复落定→「过程·2步」折叠展开收起，19:21 实录截图在案。确认两条在案边界：移动视口 v0 不适配（#49 明确单外，桌面视口达标）；工作区新增/切换不入 mock 合同（仅既有工作区，contract 边界非缺陷） |

补充证据：
- host.describe 无 dsh 品牌字段（版本 0.1.0-mock / cwd /mist），符合契约「不含 dsh 品牌」。
- 残留 "DeepSeek/@deepseek-ai" 串均为包命名空间与 CSS 类名（归属保留桶），非可见品牌；可见面（title/wordmark/favicon/onboarding/workspace 标签）已全 mist。
- mock 既有会话 session-aebe7246…（asOfSeq=21）为折叠/工具/流式的历史数据源。

## 勘误

- merge `27ddd4c` 的提交信息写有「skin.config.json→alias覆盖+mist主题id（e59d21c）」——**e59d21c 不存在**，实际合入内容为 `71ed198`（mist-skin.css 层叠覆盖 + boot.tsx 引入，无 skin.config、无主题 id 注册）。以本条为准，不为改描述补假 merge。skin.config.json 机制后于 `xiaomian/skin-config` 落地成真（见「皮肤配置层」节），此条幻影账就此还清。
- merge `3993901`（后被大审⑤退回重放为 `6cdca6d`）曾把重写前旧史跨史接回 main，已重置修正。
