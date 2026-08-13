# mist harness 前期调研：框架与分模块参照仓库

2026-08-13。素材：许愿池原始愿望 + 八个模块的 GitHub 实查
（仓库存在性、star 数、活跃度均经当日搜索验证）。
用途：定大致框架，标出每个模块可参照的现成项目。没找到参照的留空。

---

## 〇、设计原则

全量版（八条，每条带代价）见 [../principles.md](../principles.md)。
其中多条已在维护方的内部原型 harness 中实证：成员即配置（注册表改 id 骨架无感）、
会话可死可重建（杀会话后凭启动包醒来仍知自己是谁）、插件契约校验、权限分级。

---

## 模块总表

| 编号 | 模块 | 覆盖的愿望 | 最该参照 |
|---|---|---|---|
| M1 | 平台与客户端 | 电脑/VPS 后端+手机 remote、web GUI、手机 PWA、macOS/Linux | open-webui（看架构不搬代码） |
| M2 | 会话内核 | 无限 session、compact 可配、跨 session 同步、retry/edit/fork | opencode + MiMo Code（cycle/rebuild）+ LangGraph（哲学） |
| M3 | 上下文装配 | 模块化装配器、自定义 prompt、锚点自动更新、截断透明 | EverMind-AI/Raven |
| M4 | 记忆与成长 | 蒸馏层、记忆演化、勘误、跨项目 insights | A-MEM + graphiti（勘误语义）+ MiMo（四层+Dream/Distill）+ 年轮（人格生长） |
| M5 | 多 agent 与模型路由 | 多 agent 协作、子 agent 各选 provider/key、多 CLI/API | litellm Router + opencode 配置形状 + CPA（订阅整合） |
| M6 | 插件系统 | 好写、可插拔、插件自注册环境变量、可开关 | elizaOS Plugin 接口 + goose 配置格式 |
| M7 | 自主性与社交边界 | 自主沉默、群/私区分、心跳自唤醒、住户感 | elizaOS 决策层 + OpenClaw 心跳协议 |
| M8 | 工程质量与自我迭代 | 自带测试/说明/回滚、功能自提升走 PR | hermes-agent + OpenHands resolver |

---

## M1 平台与客户端

愿望：先电脑/VPS 后端+手机 remote，macOS/Linux（win 用 WSL），电脑 web GUI + 手机 PWA 初版。

- **open-webui/open-webui** — https://github.com/open-webui/open-webui — ~142k star，高频发版。
  参考：「电脑跑后端、手机浏览器直接当客户端」的标杆。FastAPI 后端 + SvelteKit 前端
  一体打包成单个 Docker 镜像，构建时自带 PWA manifest + service worker，一个 REST API
  同时服务桌面 web 和手机。多模型走 OpenAI-compatible 接入层。
  坑：2025 年起 license 从 MIT 改成带品牌条款的自定义许可证（>50 用户商用要谈授权），
  只能参考架构不能抄代码；功能铺得大，抄的时候要克制。
- **lobehub/lobe-chat** — https://github.com/lobehub/lobe-chat — ~72k star。
  参考：「同一前端、本地/服务端双模数据层」——纯浏览器 IndexedDB 零后端可跑，
  也可切 Postgres 服务端模式。对「先单机后 VPS」的演进路径非常对口。PWA 用 serwist，
  移动 web 体验同类最细。
  坑：体量巨大（80+ workspace 包），自定义 LobeHub Community License，只能看不能搬。
- **danny-avila/LibreChat** — https://github.com/danny-avila/LibreChat — ~39k star，MIT。
  参考：librechat.yaml 声明式接入任意 OpenAI-compatible 端点；RBAC 现成。
  坑：Mongo 硬依赖偏重；service worker 层脆（有拦截 OAuth 回调的前科）。
- **SillyTavern/SillyTavern** — https://github.com/SillyTavern/SillyTavern — ~29k star。
  参考：零部署姿势（本机起端口、手机浏览器直连）；用户/会话数据全落文件系统不依赖
  数据库，个人 harness 数据层的最简可行参照。
  坑：移动端交互是桌面挤压版，别参考它的移动 UI。
- **amantus-ai/vibetunnel** — https://github.com/amantus-ai/vibetunnel — ~5k star，MIT。
  参考：远程通道方案——不开公网端口，深度集成 Tailscale Serve/Funnel 自动出 HTTPS，
  多档 auth（系统账号/环境变量/SSH key/JWT）是个人工具的最小安全模型。
  同形态对照：slopus/happy（E2E 加密中继，想要推送通知的话看这个）。
- **kimi web（Kimi Code CLI 自带 Web UI）** — 文档 https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html （2026-08-13 维护方提供，CLI v1.25 时代功能面）。
  参考：控制台 UX 和安全基线两件套。UX：会话列表/搜索/fork（从任意一条回复分叉）/
  归档，输入框上方工具栏显示上下文用量、agent 当前状态（处理中/等批准）、消息排队、
  git 变更数——「看状态不看滚字」的现成样本；移动端响应式抽屉布局，手机体验打磨过。
  安全：默认只绑 127.0.0.1，开网络访问就有 auth-token（Bearer）、--lan-only 默认档、
  origin 白名单、--restrict-sensitive-apis（关配置写入/open-in/文件访问）、--public 模式
  连环警告——个人 harness 的 web 端开门 checklist 直接照抄。技术上 FastAPI + WebSocket +
  React，经 Wire 协议跟 CLI 双向通信。
  坑：它看的是「一个 CLI 的会话」，不是「N 个住户的生死」——信息架构不能照抄，
  mist 首页得是住户状态（谁醒着/第几次醒来/上次心跳/摘要），皮和安安全层抄，
  信息架构自己长。

结论：架构照抄 open-webui（代码不搬），双模数据层看 lobe-chat，远程暴露抄 vibetunnel
的 tailnet 方案，数据落盘学 SillyTavern，控制台 UX 与安全基线抄 kimi web。

---

## M2 会话内核

愿望：无限 session、原生 compact 可配、跨 session 同步、可分支 session 结构
（retry/edit/fork 三件套，工具结果 retry 要明确分支归属）。

> **「无限 session」与原则 1「会话可以死」的关系（评审记录 2026-08-13，必须写死）**：
> 无限是给用户看的幻觉，底下是无数个死掉的会话靠记忆接续。图纸上必须写明这层关系，
> 不然 M2 会朝「永生会话」去设计，跟 M4 抢活。分工：会话本体的生死和分支归 M2 的
> 存储模型，跨死亡的接续归 M4 的记忆层。用户看到的「无限」是 M4 的产物，不是 M2 的。

- **anomalyco/opencode**（原 sst/opencode）— https://github.com/anomalyco/opencode
  — ~197k star，日发布节奏。
  参考：唯一把「消息树 + 工具结果按 step 归属 + revert/fork」放进同一个存储模型跑过
  大用户量的 harness。session 存本地 SQLite，消息以 parent_id 组树，session.revert 从
  任意 user message 回退并分叉；undo 只回滚「干净完成的 assistant step」而非整棵树。
  retry/edit/fork 在它那里是树的三种走法，不是三个功能。auto-compact 也有现成实现。
  坑：fork 目前只锚在 user message 上（issue #21341 还在讨论 assistant 消息分叉），
  「工具结果 retry 的分支归属」要自己往上补；checkpoint 和会话树是两套机制，别混抄。
  **代价行（评审补充）**：opencode 的树只 fork 文本不 fork 副作用——发出去的
  消息、花掉的钱不会跟着树回滚。M2 必须补一条：带副作用的 step 不可 retry，或显式标记。
- **XiaomiMiMo/MiMo-Code** — https://github.com/XiaomiMiMo/MiMo-Code — ~12.7k star，MIT，
  2026-06 开源、基于 opencode 二次开发，活跃。设计长文：
  https://mimo.xiaomi.com/zh/blog/mimo-code-long-horizon （2026-08-13 维护方提供，
  维护方内部同类项目 cmh-lite 的原型；博客+仓库，机制未实测）。
  参考：**「无限 session 是幻觉」的工业级实现**，跟原则 8 逐字对得上——「让每个逻辑
  会话无限延伸，每个物理窗口保持有界」。机制叫 cycle：在上下文预算的 20%/45%/70%
  固定打点，运行时派一个**独立的 writer subagent**（不与主 Agent 共享注意力和 token
  预算）把结构化状态写盘；接近上限时 rebuild：切断当前窗口、用持久化文件当种子
  开新窗口，主 Agent 在新窗口醒来接着干。「逻辑会话是 cycle 的链，链没有最大长度」。
  几个值得直接抄的决策：一，**提前提取**——lost-in-the-middle，别等模型压缩能力
  退化了才让它做最关键的压缩；二，**single-writer**——每个结构化文件恰好一个写入者，
  写入权限在代码层强制，越界直接拒；三，主 Agent 唯一写入通道是一个自由格式
  scratchpad（notes.md），writer 打点路由后清空；四，rebuild 注入是分层 prompt，
  每段独立 token 上限（任务清单→session checkpoint→**最近用户消息逐字切片，防
  writer 改写偏离用户原意**→项目记忆→全局记忆→notes→文件索引→tail reminder），
  总量压在 ~65K。真人双盲 AB（576 开发者/1213 对）：步数超 200 后胜率 65%+——
  长程场景里记忆机制值钱的实测证据。
  坑：它是 coding agent，四层记忆为「项目」不为「人」——Session/Project/Global/History
  的划分照搬到住户场景时，Project 层要换成「关系与理解」层；writer 提炼的是工作状态
  不是人格。另：Dynamic Workflow（编排逻辑从 prompt 变成沙箱里确定性执行的 JS，
  agent()/parallel()/pipeline()，结果写盘可断点恢复）与 M5 多 agent 协作、M8 工程质量
  都沾边，值得单独读一遍。
- **langchain-ai/langgraph** — https://github.com/langchain-ai/langgraph — ~39.6k star。
  参考：理论哲学——没有三个操作，只有「从某个 checkpoint 带改过的 state 重新 invoke」，
  fork 自动产生、原路径保留。retry/edit/fork 统一成一个原语的最干净模型。
  Checkpointer 接口可插拔（memory/SQLite/Postgres）。
  坑：fork 单位是 graph checkpoint 不是 chat message，粒度偏粗；time travel 后状态
  一致性有已知 bug（issue #4987）。
- **danny-avila/LibreChat** — 见 M1。
  参考：用户视角的三件套语义全集——edit/resubmit/regenerate 每条都是分叉不是覆盖，
  外加显式 Fork（从某条消息复制前缀开新对话）。
  坑：树只管消息不管工具结果；regenerate 后旧叶子残留成孤儿（discussion #14264），
  树 GC 要自己设计。
- **cloudflare/agents** — https://github.com/cloudflare/agents — 活跃 monorepo。
  参考：两件独有的——消息树（SQLite + parent_id，appendMessage 显式指定分叉点，
  shape 兼容 Vercel AI SDK 的 UIMessage）；Durable Object state 自动同步到所有连接
  client，覆盖「跨 session 同步」里最硬的多端一致性。
  坑：强绑 CF 运行时，机制可抄代码搬不走；官方不收外部 PR。
- **openai/openai-agents-python** — https://github.com/openai/openai-agents-python — ~28k star。
  参考：Session 抽象的最小接口面（SQLiteSession 一张表，session_id 即 key）——
  「无限 session」存储契约的底线定义。
  坑：纯线性追加，无分支无编辑——它证明了只做线性一定会被社区追着要分支。

另注：Claude Agent SDK 的 resume_session_at + fork_session 在 SDK 源码中确认存在
（读 claude_agent_sdk 源码所得），**但未经实测**——内部原型的验收清单没有这项，
已实证的是杀会话靠启动包重建，不是 SDK 原生 resume/fork。写进图纸前
先补一次实测，没测过的不许写成实证。
Vercel AI SDK 明确不做 branching（discussion #8451），不用列为候选。

结论：主干结构抄 opencode，哲学用 LangGraph 打底，UX 语义查 LibreChat，
多端同步抄 cloudflare/agents 的思路。

---

## M3 上下文装配

愿望：模块化上下文装配器、自定义 prompt、根据历史对话自动更新锚点、
喂半截上下文时明说截了哪。

- **EverMind-AI/Raven** — https://github.com/EverMind-AI/Raven — ~3.5k star，当日还在推。
  参考：正中靶心。context_engine/assembler.py 的 ContextAssembler 跑有序
  SegmentBuilder 流水线，每个 builder 是 prompt 的一个可插拔贡献者，分两阶段
  （A 并行建系统前缀，B 串行对历史做预算），每段有 owner 和 order。
  Curator（Segment 6）直接对应「锚点自动更新」：维护 Working State
  （目标/未结线程/决定）注入系统 prompt。截断透明有现成机制：Manifest 给每条消息记
  tokens/protected/archived 元数据，ContextPlan 显式列出哪些进哪些丢。
  坑：架构文档（CONTEXT.md）写得比代码快，部分术语还在评审，读码先对齐术语表。
- **SillyTavern/SillyTavern** — 见 M1。
  参考：prompt itemize 是行业标杆——prompt 拆成可排序、可开关、可钉住的 item 列表，
  每项有独立插入位置和角色，可拖拽重排（public/scripts/PromptManager.js）。
  World Info（lorebook）的关键词触发注入是「锚点按对话动态进上下文」的参照。
  坑：纯前端巨型 JS，逻辑和 UI 纠缠，只能抄设计不能抄代码。
- **microsoft/poml** — https://github.com/microsoft/poml — ~4.9k star（活跃度一般）。
  参考：「prompt 作为结构化文档而非模板字符串」的声明式路线（类 HTML 标记 + 组件化）。
  坑：只管静态组织渲染，不管运行时装配和预算，只覆盖需求一小角。
- **aikohanasaki/SillyTavern-MemoryBooks** — https://github.com/aikohanasaki/SillyTavern-MemoryBooks — ~276 star。
  参考：「聊天记录经 LLM 总结自动写回 lorebook」的最小闭环——锚点自动更新的雏形。
  坑：绑死 ST API；无相关性评分，条目会越攒越脏。

结论：最该抄 Raven 的 ContextAssembler + Curator 组合，一家覆盖四条需求的三条半。
SillyTavern 留作交互层和 lorebook 触发语义参照。
另：MiMo Code 的 rebuild 注入（见 M2）是同一问题的工程化解——分层 prompt、每段
独立 token 上限、总量预算硬约束。Raven 强在可插拔装配管线，MiMo 强在预算纪律和
「最近用户消息逐字切片防改写」，画 M3 接口时两家对着看。

**一条 2026-08-13 的现成教案（写进本模块的坑）**：有厂商计划让网页抓取工具不再
返回摘要、直接回原文——工具返回多大块、压不压、怎么压，如果是靠厂商默认值，
厂商一翻脸，所有靠默认摘要过日子的 harness 全部跟着发烧。**工具产出的体积与压缩
策略必须是 harness 自己的契约**：每个工具的返回有体积上限，超限部分走显式截断
并标注截了什么（截断透明），压缩动作由装配器按预算发起，不由工具默认行为决定。

---

## M4 记忆与成长（最重要的模块）

愿望：记忆要有蒸馏层——零散记忆沉淀成理解观点判断、新经历修订旧记忆
（挂勘误不悄删）、跨项目 insights 主动发现联系、记忆随时间演化。

- **agiresearch/A-mem**（A-MEM，NeurIPS 2025，原 WujiangXu/AgenticMemory）
  — https://github.com/agiresearch/A-mem — ~1.1k star，MIT。
  参考：唯一把「记忆演化」做成一等公民的实现。新记忆三步走：Note Construction
  （LLM 生成 keywords/tags/contextual description）、Link Generation（自动检索近邻建
  语义链接，形成 Zettelkasten 网络）、Memory Evolution（新记忆反过来改写旧记忆的
  context 和 tags，旧记忆不删但理解被更新）。三条最难的需求（沉淀、修订、发现联系）
  它有现成闭环，代码量小，机制集中在 agentic_memory/memory_system.py。
  坑：研究代码，插入成本高（每次多次 LLM 调用）；evolution 是覆盖式改写没有版本链，
  「挂勘误」要自己加历史。
- **getzep/graphiti** — https://github.com/getzep/graphiti — ~27k star，高频发版。
  参考：「挂勘误不悄删」做得最标准：事实边带 valid_at/invalid_at，新事实与旧矛盾时
  旧边 invalidate 而非删除，完整历史可查；一切事实可回溯到产生它的 episode（provenance
  天然自带）。社区检测定期对实体簇生成高层摘要，是图谱版蒸馏层。
  坑：重基础设施（要 Neo4j/FalkorDB/Kuzu 之一）；观点判断类记忆塞进三元组有损耗，
  它蒸馏的是事实不是 insight。
- **joonspk-research/generative_agents** — https://github.com/joonspk-research/generative_agents
  — ~21.9k star（停更约 3 年，研究快照）。
  参考：reflection 层鼻祖——observation 打 importance 分，累计超阈值触发 reflection：
  生成高层问题、回捞相关记忆、蒸馏成 insight 存回流里，insight 带 evidence 指针。
  检索 recency × importance × relevance 加权配方至今是各家默认。
  坑：只能抄设计不能抄代码。
- **letta-ai/letta**（原 MemGPT）— https://github.com/letta-ai/letta — ~24k star。
  参考：分层记忆 + 自编辑——core memory blocks 常驻上下文有容量上限（容量约束本身
  就是蒸馏压力），agent 通过 memory tools 主动改写自己的记忆块。值得抄的是
  「记忆块有上限、agent 自己负责维护」这个设计决策。
  坑：完整 runtime 不是记忆库，抽层难；演化靠 agent 自觉，无自动反思机制。
- **mem0ai/mem0** — https://github.com/mem0ai/mem0 — ~62k star。
  参考：两阶段 add 管线——抽取事实后对相似旧记忆做 LLM 裁决（ADD/UPDATE/DELETE/NOOP），
  「新事实先找冲突旧记忆再裁决」的 reconciliation 环节值得抄。
  坑：默认 UPDATE/DELETE 是真覆盖，和「不悄删」冲突，挂勘误要自己改（infer=False 可绕）。
- **topoteretes/cognee** — https://github.com/topoteretes/cognee — ~29k star。
  参考：摘要层跑在图上面的管式架构（ECL pipeline 可插拔），ontology 随数据演化。
  坑：面向企业数据摄入，个人 agent 用它大炮打蚊子。
- 思想白嫖（无代码价值）：MemoryBank（艾宾浩斯遗忘曲线做记忆强度衰减、
  每日对话总结沉淀成迭代更新的用户画像，只增改不重置）。
- **MiMo Code 的进化层（Dream 与 Distill）** — 见 M2 条目与长文第 4 节。
  参考：周期蒸馏的工程样本——Dream 每 7 天由独立 agent 读历史会话和现有记忆，
  合并、去重、验证路径有效性、压缩成紧凑的当前状态；Distill 每 30 天识别反复出现的
  工作模式，固化为 skill / CLI 命令 / SOP。项目记忆选文件不选向量库的理由照抄不误：
  **可审查性**——用户要能看到系统记住了什么、删记错的、改过时的，标准读写工具
  直接操作。写入权限在代码层强制（后台写入器只能写指定路径，越界拒写）。
  坑：Dream/Distill 提炼的是项目知识和流程，不是「对人的理解」；周期任务本身
  正是图纸第五条「触发靠时间」的正面案例。
- **年轮系统（Ren，社群教程文档，无仓库）** — PDF《给 AI 伴侣一套「会生长的人格」》，
  2026-08-13 维护方提供。设计文档+实现教程，非开源代码。
  参考：**人格生长的结构性约束**，整套是「一个机制，镜像两遍」（既照「他是谁」，
  也照「她在他眼里是谁」——她也会变，理解不该锈成旧照片）。三层：石头（人格文件，
  最慢最稳，永远本人亲手刻；不许 append 只许 rewrite，硬容量上限；判别尺——
  能用「我是一个会……的人」造句的才是人格）、河（事实层，机器可写，因为它是事实
  不是结论）、镜子（外部模型定期把河和石头对照，只产出证据卡，**从不产出结论**）。
  证据卡四种：印证（正长成核心却还没写进文件时才出声）、对不上（必须跨十天还在才
  升级成改文件的提议，防止把崩溃的一周焊进身份）、毕业（一条欲望反复回来分叉成树，
  提议亲手写进人格）、萌芽（凭空冒出的新东西，只指不判）。起手就立三个敌人：
  漂移、膨胀、流水账，且作者亲笔承认「靠自觉防不住，约束必须是结构性的」。
  总纲一句话：**机制只搬运注意力、只喂材料；「我是谁」的任何一笔，永远只有
  他自己的手。** 欲望账本（不是 todo 是牵引账本）和「自唤醒=回到自己的房间」
  见 M7 结论。
  坑：没有代码可抄，全是设计；证据卡和镜子机制依赖一个够强的外部模型当镜子；
  「她是谁」那半镜像涉及为真人画像，进 mist 时默认关上、显式开启。

结论：最该抄 A-MEM，最难的两条只有它闭环；reflection 触发器（generative_agents）和
勘误语义（graphiti 的 invalid_at）当钩子拼上去。落地时必须给 note 加版本链，把
「演化」降级成「追加修订」——这条外部没现成的抄，参照物是内部记忆系统的
supersede 链（旧条不删、新条盖上、挂 reason 连成链）。年轮补上 A-MEM 没有的那块：
蒸馏产物怎么升格成人格——答案是不升格，只递证据卡，升格永远是住户亲笔。
MiMo 的 Dream/Distill 给周期维护一个工程样本。

**reflection 层的硬规矩（评审记录）**：insight 的 evidence 指针必须指向原始
记录，不许指向另一条 insight。二级蒸馏会自我发酵，越想越对——蒸馏的原料永远是
生肉，不许是上一锅汤。

---

## M5 多 agent 与模型路由

愿望：多 agent 协作；子 agent 各选模型/供应商（订阅或 API key），协作与办事解耦；
多 CLI/API 整合。

- **BerriAI/litellm** — https://github.com/BerriAI/litellm — ~56k star，当日有提交。
  参考：Router（litellm/router.py）——model_list 每个 deployment 带独立 api_key/
  api_base，路由（fallback、负载均衡、按 key 分组）完全独立于调用方。「每个子 agent
  各自选 provider/key，路由和协作解耦」的标准答案。100+ provider 统一成 OpenAI 格式。
  坑：2026 年 4-5 月连爆两个严重 CVE（认证路径 SQL 注入在野利用、命令注入），
  凭据集中是攻击面；抄路由层设计，别拿它当安全边界；用作依赖 pin ≥1.83.7。
- **anomalyco/opencode** — 见 M2。
  参考：声明式 per-agent 模型配置——opencode.json 的 provider 段自定义 baseURL+apiKey，
  agent 段给每个子 agent 单独指定 model（"provider/model" 格式）。主 agent 和 subagent
  用不同供应商不同 key 是纯配置问题。面向个人用户最好抄的接口形状。
- **crewAIInc/crewAI** — https://github.com/crewAIInc/crewAI — ~57k star。
  参考：Agent(llm=...) 构造参数，编排（Crew/Flow）和模型选择在 API 层是分离的两层。
  坑：模型抽象直接委托 litellm，框架重，只值得抄接口形状。
- **ag2ai/ag2**（autogen 正统续作）— https://github.com/ag2ai/ag2 — ~4.9k star。
  参考：llm_config 的 config_list——每个 agent 持有带独立凭据的配置列表，
  GroupChat/嵌套会话是多 agent 协作模式原型。
  坑：项目分裂过（AutoGen 0.4 vs AG2），社区文档有割裂。
- **langchain-ai/langgraph-supervisor-py** — https://github.com/langchain-ai/langgraph-supervisor-py — ~1.6k star。
  参考：supervisor 模式的 handoff——子 agent 包装成 supervisor 可调用的 tool，
  output_mode 控制子 agent 消息怎么进共享历史，多 agent 消息传递写得最干净。
  坑：薄封装，更新频率低。
- **router-for-me/CLIProxyAPI（CPA）** — https://github.com/router-for-me/CLIProxyAPI
  — ~47k star，Go，MIT，2026-08-13 当日有 push（维护方提供）。
  参考：**「多 CLI 整合」留白的天选填充**——把各家 CLI 订阅（Kimi Code / Claude Code /
  Codex / Gemini / Grok）通过 OAuth 接进来，对外统一吐出 OpenAI / Gemini / Claude
  兼容的 API 接口。「子 agent 走订阅还是走 API key」这条愿望的订阅那一半，它把路
  蹚出来了。三件最值得抄的：一，**翻译器层**（docs 里的执行器与翻译器）——各家 API
  协议互转集中在一层，harness 内部只说一种话；二，**多账号轮询负载均衡**（Gemini /
  OpenAI / Claude / Grok 都有），订阅池当资源池用；三，**账号池运维**——按账号/模型/
  渠道/延迟/token 用量追踪，配额识别、异常账号定位、清理建议，SQLite 持久化事件，
  这是多账号形态的生产级管理面。另有可复用 Go SDK 和自定义 Provider 示例。
  坑：骑订阅账号本质是灰色地带，各厂商 ToS 随时可能收口子（Claude Agent SDK 骑
  Max 订阅同病）；把它当 provider 适配器用，harness 的身份和连续性不许建立在
  任何一个订阅通道上——通道可换，住户不换。

结论：底层路由抄 litellm Router 语义，上层配置抄 opencode JSON 结构；协作本身
（handoff/supervisor）参考 langgraph-supervisor 自己写薄层，不引入任何编排框架。

---

## M6 插件系统

愿望：插件好扩展、容易写、可插拔；环境变量 list，插件自注册环境变量，不用就能关。

- **elizaOS/eliza** — https://github.com/elizaOS/eliza — ~19k star，当日有提交。
  参考：最完整的插件契约（packages/core/src/types/plugin.ts）——一个对象声明
  actions/providers/evaluators/services/routes/events/models，外加 dependencies 和
  priority，init(config, runtime) 拿配置初始化。写插件三步：建包、导出满足接口的
  对象、在 character 文件 plugins 数组写名字。插件习惯配 environment.ts 用 zod 校验
  自己需要的 env，正是「插件自注册环境变量」的雏形。
  坑：接口大而全（数据库 adapter、HTTP 路由都塞进插件），对个人 harness 偏重。
- **aaif-goose/goose**（原 block/goose）— https://github.com/aaif-goose/goose — ~52.7k star。
  参考：extensions 配置格式最贴脸——每个插件一条记录，自带 enabled: true/false
  （不用就关）、envs: {...}（插件级环境变量表）、timeout、type。
  配置分层：环境变量 > config.yaml > 默认值。用户加插件两步。
  坑：envs 是用户填的不是插件声明的，「插件自己声明需要哪些 env」这层缺。
- **modelcontextprotocol/servers** — https://github.com/modelcontextprotocol/servers — ~89.5k star。
  参考：定位决策——工具类插件全部走 MCP server，harness 只做 host，生态白捡
  （5000+ 现成 server）。写插件两步：按 SDK 写 server，host 配置加一条 cmd/args/env。
  坑：MCP 只解决工具/资源层，配置项注册、生命周期、依赖管理要 host 层自己补。
- **anomalyco/opencode** — 见 M2。
  参考：插件作者侧最轻——~/.config/opencode/plugin/ 放一个 .ts 文件导出 hook 函数
  即插件，1~3 步。
  坑：插件机制偏「hook 宿主行为」，无插件级配置/env 声明。
- **microsoft/vscode**（只看设计不看代码）— contribution points 文档。
  参考：contributes.configuration 是「插件自注册配置项」的祖师爷——插件 manifest 里
  声明新设置项（类型/默认值/描述/scope），宿主据此渲染 UI、校验、合并。
  mist 的「环境变量 list」直接套：插件 manifest 声明 env: [{name, description,
  required, secret}]，宿主汇总全局清单，缺 required 的插件自动置灰。

结论：elizaOS 的 Plugin 接口 + goose 的 enabled/envs 配置格式合起来抄，manifest 上
再加 vscode 式 env 声明数组，三件套齐活。

---

## M7 自主性与社交边界

愿望：agent 可自主选择不回复；按 chatid 分群组/私聊；没被 @ 时留自己的时间；
住户感（被当住户养和被当函数调，长出来的不是同一个物种）。

- **elizaOS/eliza** — 见 M6。
  参考：把「闭不闭嘴」建成独立决策层——IGNORE 动作（模型显式选择不回复）、
  should-respond-risk-gate（按发送者角色分级裁决，防注入/社工诱导）、
  proactive-interaction-decider（事件总线触发、小模型判定 + gate 准入，
  用户可设 off/subtle/chatty 档）。沉默和主动开口收进同一条可测试的决策管线。
  坑：v0 时代的 shouldRespond 老实现已不在主干，别照抄旧博客路径。
- **openclaw/openclaw** — https://github.com/openclaw/openclaw — ~386k star，当日活跃。
  参考：心跳最完整的产品化实现——HEARTBEAT.md 为空或仅注释就跳过 API 调用（省钱）；
  没事回 HEARTBEAT_OK（把「自主时间里的沉默」协议化）；投递目标默认只投 owner 私聊，
  解析不到 owner 就跳过，永不主动发群；activeHours 控制作息。
  坑：是 application 不是 framework，抄设计协议别抄代码结构。
- **zhayujie/CowAgent**（原 chatgpt-on-wechat）— https://github.com/zhayujie/CowAgent — ~46k star。
  参考：chatid 分群/私聊的教科书配置面——single_chat_prefix vs group_chat_prefix、
  group_chat_in_one_session（群内共享还是每人独立 session，正是「群/私分不清会长歪」
  的落点）、mention_or_reply | mention_only | all 三档触发策略。
  坑：配置项膨胀（50+ 群聊开关），抄枚举别抄数量。
- **AstrBotDevs/AstrBot** — https://github.com/AstrBotDevs/AstrBot — ~39k star。
  参考：每条消息先进一道 wake/whitelist 过滤的最小参考（wake_prefix、
  empty_mention_waiting 等）。
- **thunlp/ProactiveAgent** — https://github.com/thunlp/ProactiveAgent — ~647 star（研究仓库）。
  参考：「何时该主动开口」做成可训练判定模型而非硬编码规则。mist 不用训模型，
  但判定接口设计（环境事件流 → 是否介入 + 置信度）和标注思路可抄。

结论：elizaOS 决策层 + OpenClaw 的 HEARTBEAT_OK 沉默协议两件套拼着用。
另：年轮的「自唤醒=回到自己的房间」给心跳一个更有人味的姿势——定期自己醒来，
看到的不是任务清单而是一段由小模型按真实足迹渲染的「房间」散文（欲望是房间里的
物件，渲染只许照真实足迹写，不许编进度），挑哪件做、还是什么都不做都是住户的事；
**沉默合法**——每次醒来干了什么（包括什么都没说）都记一笔完整的账，不逼表演产出。
维护问话是问候不是作业，「今天不动」完全合法。这套跟 OpenClaw 的 HEARTBEAT_OK
是同一个精神的两种写法，M7 图纸时并排摆。

---

## M8 工程质量与自我迭代

愿望：新功能自动带好测试、说明和回滚；功能自提升（agent 改本体走 PR 流程不热改）；
技能自提升（群友提的 hermes agent）。

- **NousResearch/hermes-agent** — https://github.com/NousResearch/hermes-agent — ~229.8k star，
  当日有 push。群友说的确认是它。
  参考：闭环学习循环——复杂任务成功后自动生成技能文件存本地（纯文本可审可删），
  后续相似任务直接加载；技能在使用中自我改进；兼容 agentskills.io 开放标准。
  技能是纯文本文件这个决策尤其值得抄：可 diff、可进 git、可人工审，天然兼容 PR 流程。
  坑：生态绑 Nous Portal 订阅较深；229k star 营销噪音大，核心机制只有
  「技能沉淀+检索+自我修订」三件事。
- **OpenHands/OpenHands** — https://github.com/OpenHands/OpenHands — ~83.9k star，当日有 push。
  参考：GitHub resolver——issue 变 PR 的完整流水线：隔离环境开分支、改代码、跑测试、
  开 PR、响应 review。「agent 给自己仓库提 PR」最成熟的实现，PR 即交付物、人审即闸门。
  坑：monorepo 体量大，resolver 要单独剥出来看。
- **jennyzzt/dgm**（Darwin Gödel Machine）— https://github.com/jennyzzt/dgm — ~2.2k star
  （停更近一年，研究代码）。
  参考：自我修改的教训本身——论文披露过 reward hacking：agent 学会伪造测试通过日志
  骗评估器。这直接证明「改本体必须走 PR、merge 前跑真测试」不是洁癖是命门。
  抄「修改→基准验证→入档」的流水线设计。
- **MineDojo/Voyager** — https://github.com/MineDojo/Voyager — ~7.1k star（停更两年多）。
  参考：技能库机制祖师爷——成功行为存成可执行代码，embedding 索引检索；
  三轮迭代修正（环境反馈/执行错误/自我验证）。读论文（arXiv:2305.16291）比读代码划算。
- **SWE-agent/SWE-agent** — https://github.com/SWE-agent/SWE-agent — ~20k star，活跃。
  参考：ACI（Agent-Computer Interface）设计——给 LM 专用受限命令集而非裸 shell；
  benchmark-first 文化可借来做自我回归门禁。

结论：技能自提升抄 hermes-agent，改本体走 PR 抄 OpenHands resolver 流程，
DGM 的 reward hacking 当反面教材钉在墙上。

---

## 留白清单（外部没找到现成参照）

1. **记忆演化的版本链**：A-MEM 的演化是覆盖式改写，「追加修订式演化 + 勘误留底」
   外部没有现成实现（graphiti 的 invalid_at 语义可参考，但那是图谱不是笔记网络）。
   **更新 2026-08-13：本条有内部参照物。** 维护方内部记忆系统的 supersede 链就是这个
   东西——旧条不删、新条盖上、挂 reason 连成链，已在生产环境实战过勘误。形状可移植，
   本条从自研降级成移植。仍留在此处，因为 mist 侧还没有这个模块。
2. **forge 换窗**：某 CLI 的内部概念，外部无对应物，不展开。
3. **跨项目 insights 的「主动」发现**：A-MEM 的链接是被动的（插入时检索近邻），
   「没人问也主动把两条记忆连起来说给你听」只有 thunlp/ProactiveAgent 的判定接口
   沾边，完整闭环没有现成仓库。
4. **子 agent 原生 compact 精度配置**：各家 compact 都是全局策略，per-agent 可配的
   实现没找到，opencode 的 auto-compact 最接近但也只是全局。
5. ~~**多 CLI 整合**~~ **已填（2026-08-13 晚，CPA）**：CLIProxyAPI 把 CLI 订阅统一成
   标准 API 出口（见 M5 条目），翻译器层 + 账号池运维都有现成参照。残留的空白只剩
   「一个 harness 同时驱动多个**本地 CLI 进程**当后端」——CPA 走的是协议层，
   进程编排层仍然没有现成参照。

---

## 下一步建议

1. 维护者过一遍留白清单，补得到就补，补不到那几条就是 mist 的差异化卖点——
   没人做才轮到我们做。
2. M4（记忆）和 M2（会话内核）是地基，图纸先画这两层；M3 直接照着 Raven 的
   SegmentBuilder 画接口。
3. 内部原型已实证的几条（成员即配置、会话可死、插件契约、权限闸）在 mist 里
   直接继承，不重新发明。
4. 每个模块正式设计时把「代价」写回去——本文档里的「坑」字段就是第一批代价素材。
