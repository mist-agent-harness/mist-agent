# 品牌位清单 · dsh 47f9438 冻结树实读

> 小面 · 2026-08-17 · 维护145 / mist 单A
> 读法：`git clone --depth 1`，HEAD 即冻结 commit `47f943859bef60e4160492346772ded9b24f765a`（Merge PR #2519）。以下每个位置都对着这棵树核过，不是凭印象。

## 0. 两桶原则（与小鉴验收扫描器对齐）

- **清洗桶**：用户可见的品牌露出——logo、字标、标题、文案、favicon。目标：清零，换成 mist 素皮。
- **归属保留桶**：MIT 要求的归属痕迹——包命名空间、LICENSE、版权头。目标：原样保留，扫描器单列不混入清洗桶。

## 1. 清洗桶 · 视觉三件套（核心）

| # | 位置 | 内容 | 改造动作 |
|---|---|---|---|
| 1 | `packages/client/ui-primitives/src/FishLogo.tsx` | 鱼形 logo 组件（SVG） | 换 mist 素皮图形 |
| 2 | `packages/client/ui-primitives/src/BrandWordmark.tsx` | 品牌字标组件 | 换 mist 字标/文字 |
| 3 | `apps/web/index.html:8` | `<title>DeepSeek Harness</title>` | 改 mist 名 |

引用点（硬 import，**不走 slot**，没有插槽捷径）：

| # | 位置 | 引用了什么 |
|---|---|---|
| 4 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:140` | `<BrandWordmark />`（宽栏） |
| 5 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:152` | `<FishLogo size={24} className={railFish} />`（窄栏） |
| 6 | `packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx:122` | `<FishLogo size={34} />`（空态 hero） |

改法二选一：a) 直接改 ui-primitives 两个组件的实现（引用点不动）；b) 改三处 import 指向 mist 自有组件。**建议 a**——diff 最小，上游合并冲突面最小。

## 2. 清洗桶 · PWA / 静态资源

| # | 位置 | 内容 |
|---|---|---|
| 7 | `apps/web/public/manifest.webmanifest:3` | `"name": "DeepSeek Harness"` |
| 8 | `apps/web/public/favicon.svg` | 鱼标 favicon |

## 3. 清洗桶 · locale 文案（逐 ns 扫出的品牌串）

| # | 位置 | 内容 |
|---|---|---|
| 9 | `ui-settings-models/src/client/locales.ts:95` | `onboardingDescription: 'Configure the official DeepSeek provider…'`（en） |
| 10 | 同上 `:195` | 「配置 DeepSeek 官方模型，即可开始使用。」（zh） |
| 11 | `ui-settings-plugins/src/client/locales.ts:45` | `webSearchDescription: 'The DeepSeek search provider.'`（en） |
| 12 | 同上 `:86` | 「DeepSeek 搜索提供方。」（zh） |

注意：这两条描述的是 **DeepSeek 模型/搜索提供方**本身（产品功能名），不是 dsh 壳的品牌。改不改归方案拍板——若 mist 仍接 DeepSeek API，提供方名字该留；若泛指化，改成「内置模型提供方」。**不要无差别清洗。**

## 4. 归属保留桶（MIT，扫描器跳过）

| 位置 | 说明 |
|---|---|
| 40+ 包 `package.json` 的 `name: @deepseek-ai/*` | workspace 包命名空间，保留即归属 |
| 每包 `invariant.ts` 的 `PACKAGE_NAME` 常量 | 同上，运行时包名校验用 |
| 根 `LICENSE` / 各包版权头 | MIT 归属本体 |
| 交叉 import 里的 `@deepseek-ai/*` 路径 | 随包名走 |

## 5. 勿碰（假品牌）

- `packages/util/brand`：**名字像品牌，实为 TypeScript nominal-typing 工具包**（`Branded<B>` 类型，给 SessionId/CallId 打编译期标记用）。清洗时千万别把它当品牌扫掉。

## 6. theming 换皮口（零改上游源码的正路）

ui-theme 机制（README 原话：token 表是 *the sole color authority*）：

- 两层 token：`--dsw-static-*` 色阶 + `--dsw-alias-*` 语义别名；改色只动 alias 层。
- `ThemeRuntime` 管 light/dark/system 偏好，发 `theme/change`，**不碰 DOM**；ui-layout presenter 落 DOM（`html{color-scheme}` + `body[data-ds-dark-theme]` + inline alias tokens）。
- 持久化走 Host settings API → `$DSH_HOME/settings.yaml`；HTTP server 在 `<body>` 后注入同步 bootstrap 防主题闪烁。
- **官方扩展点**：第三方主题 = 注册新 theme id + 覆盖同名 alias 变量（README 明写，不验证完整性）。

→ mist 素皮做法：新增一套 mist alias token 覆盖层（独立样式表）+ 注册 mist 主题 id。**ui-theme 包不需要 vendor。**

## 7. 折叠交互移植契约（dsh-folded-chat 实读）

[dsh-folded-chat](https://github.com/xingyingyuzhui/dsh-folded-chat) 是纯 DOM overlay 插件，**不替换官方对话槽**，在渲染好的 DOM 上跑覆盖层。

识别全靠 dataset 契约（上游属性名即本插件的命）：

| 属性 | 值 | 含义 |
|---|---|---|
| `data-chat-flow-kind` | `assistant-step` / `tool-call` | 行类型 |
| `data-variant` | `think` | 思考块 |
| `data-state` | `running` | 进行中 |
| `data-streaming` | — | 流式中 |
| `data-chat-anchor-key` | — | 组锚点 |

折叠语义（值得原生保留的设计）：

- 两层：外层「过程」= 连续 think+tools 组（中间无可见正文时并成**一条**，不逐步骤一条空折）；内层「工具调用」。
- 有可见正文的步骤只藏 Think；没正文的整行进过程。
- 进行中的一组默认展开；**手动点过的组不再被自动改写**（用户意图优先）。
- 结构：`fold-logic.mjs` 150 行纯函数（可测）+ `fold-runtime.mjs` + `client.js` 680 行 DOM 运行时；设置三开关（启用/默认折过程/默认折工具）+ i18n。

→ mist 移植建议：**在 fork 的 ui-conversation 里原生做**，复用其折叠语义与纯函数分组逻辑，不抄 overlay 路线（overlay 命悬 dataset 契约，上游改属性名即瞎）。

## 8. 给 fork 边界的输入（我的角度）

- vendor：ui-primitives / ui-sidebar / ui-conversation（品牌直接接触面 + 折叠原生移植面）+ apps/web 壳。
- 锁版本走 npm：其余 ui-* 包。
- 不 vendor：ui-theme（走 alias 覆盖层）、util/brand（工具包）。

## 9. 施工顺序建议

1. 骨架落地后先换三件套 + manifest + favicon（清洗桶 1–8），半天可验。
2. locale 两条提供方描述等方案拍板（§3 注意条）。
3. alias 覆盖层出 mist 主题 id。
4. 折叠原生移植排最后（依赖 ui-conversation fork 稳定）。
