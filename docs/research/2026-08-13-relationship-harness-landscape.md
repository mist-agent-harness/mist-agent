# 面向长期人机关系的 Agent Harness：生态调研与产品缺口

> 日期：2026-08-13
> 状态：调研输入，不是架构合同，也不代表项目已经作出技术选型。

## 摘要

现有开源生态已经很好地覆盖了模型接入、agent loop、工具调用、会话树、上下文压缩、
多端访问、角色卡、长期记忆和消息渠道。mist 没有必要为了“全部自己写”而重造这些能力。

本轮检索范围内仍未找到一个成熟项目，同时把下面几件事做成可移植、可修订、可审计的
一等数据结构：

- 双方各自有权定义什么，系统不能替任何一方悄悄下结论；
- 直接陈述、转述和推断不会混成同一种“记忆”；
- 关系事实有出处、时效、修订和撤回语义；
- 模型、provider、会话和客户端都能替换，关系连续性不随之消失；
- 亲密表达不会自动扩大文件、设备、付款、删除或部署权限。

本文把这组尚未被完整覆盖的边界暂称为 **Relationship Core**。这是待讨论的设计假设，
不是已冻结的模块名。

## 1. 方法、证据等级与限制

本文合并了两轮相互独立的桌面调研，材料以公开仓库、官方文档、论文和少量关键源码为主。
没有对所有项目做完整安装、长期运行或安全审计，因此“支持某能力”通常只表示公开实现或
文档中存在该机制，不等于已验证其生产可靠性。

材料分三档：

1. **公开实现或官方文档**：可作为工程参照，但采用前仍需核许可证、版本和实际行为；
2. **厂商报告**：只能写成厂商报告的观察，不能改写成本项目已复现的结论；
3. **社群设计材料**：可贡献问题定义和设计语言，不当作可直接复用的开源实现。

GitHub 热度和活跃度只用于说明调研时的生态位置，不用于证明质量。本文避免固化会快速过期
的 star 数；若后续需要选型，应重新拉取当日数据。

“未发现”只对本轮检索范围负责，不表示互联网上绝对不存在类似项目。

## 2. 生态分层

### 2.1 角色扮演与 Character 前端

代表项目：
[SillyTavern](https://github.com/SillyTavern/SillyTavern)、
[RisuAI](https://github.com/kwaroran/Risuai)、
[Character Card V3](https://github.com/kwaroran/character-card-spec-v3)。

它们已经很好地解决角色卡、用户 Persona、Lorebook、prompt 编排、模型切换和跨前端角色
携带。它们证明了“身份配置应该可以被用户看见和搬走”。

主要缺口是：角色设定通常是一份单向配置，关系状态常散落在角色卡、聊天记录和 lore 中。
“角色怎么描述用户”与“用户如何定义自己”缺少独立权威；更正、撤回、转述和推断也很少
有结构化边界。

### 2.2 通用 Agent Runtime 与个人 Harness

代表项目：
[Pi](https://github.com/earendil-works/pi)、
[OpenCode](https://github.com/anomalyco/opencode)、
[OpenClaw](https://github.com/openclaw/openclaw)、
[Open Hanako](https://github.com/liliMozi/openhanako)、
[OpenMinis](https://github.com/OpenMinis/OpenMinis)、
[Goose](https://github.com/aaif-goose/goose)、
[ElizaOS](https://github.com/elizaos/eliza)。

这层已经覆盖了大量通用能力：provider 适配、agent loop、工具、会话持久化、分支与恢复、
多 agent、插件、定时任务、Telegram 等消息渠道，以及电脑/VPS 后端配手机 remote 的形态。

因此 mist 更合理的路线是定义稳定的 `RuntimeAdapter`，复用或驱动现成 runtime。关系、身份、
记忆权威和授权边界不应绑死在任一 runtime 的私有 session 格式上。

Open Hanako 对多住户、独立人格和定时任务很有参考价值；OpenMinis 对移动端权限和设备能力
有参考价值；OpenClaw 的 Gateway 形态说明多端访问本身已经不是空白。它们仍没有共同提供
可移植的双边关系协议和一致性验收。

### 2.3 面向长期陪伴的项目

小型 companion 项目、虚拟角色产品和研究原型共同证明了几件事：长期陪伴不只是一只聊天
气泡，共同活动、主动联系、合法沉默、空间感和持续的生活线同样重要。

但这类项目常与单一作者的世界观、UI、模型或私有数据格式深度绑定。关系数值、情绪状态或
“长期记忆”不自动等于双方权威、纠错历史和迁移能力。本轮没有找到成熟、活跃、专门提供
通用长期关系核心的开源 harness。

### 2.4 长期记忆基础设施

代表项目：
[Letta](https://github.com/letta-ai/letta)、
[Mem0](https://github.com/mem0ai/mem0)、
[A-MEM](https://github.com/agiresearch/A-mem)、
[Graphiti](https://github.com/getzep/graphiti)。

这些项目分别擅长分层记忆、检索、链接、演化和带有效期的事实图。它们适合作为候选生成、
检索或上下文投影层。

待讨论的关键边界是：外部记忆后端是否可以直接成为 Relationship Core 的权威写入者。
本文建议默认不可以。外部系统可以返回候选或投影；谁说的、谁有权修改、证据是什么、当前
是否仍有效，应由 mist 自持的最小权威结构裁决。这样更换记忆后端不会改写双方关系史。

### 2.5 具身、语音与感知

[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) 等项目说明语音、
表情、Avatar 和感知管线已有丰富积木。它们适合后续插件化，不应成为 v0 地基；具身层也
不应反向拥有关系事实或行动授权。

## 3. 不值得重造的部分

下列能力应优先适配、组合或借鉴成熟实现：

- provider/API 协议适配与模型路由；
- agent loop、工具调用和 usage ledger；
- 会话树、retry/edit/fork 与 compact；
- Web GUI、PWA、远程访问和消息渠道；
- MCP/插件宿主、定时任务和进程监督；
- 向量检索、全文检索与通用 RAG。

mist 的差异不应是“又写一个聊天壳”，而应是这些通用能力之上的关系连续性与权威边界。

## 4. Relationship Core 的待决边界

如果项目接受这个方向，最小关系记录至少需要能回答：

- `subject`：这条陈述在说谁或哪段关系；
- `authored_by`：谁作出了这条陈述；
- `source_mode`：`DIRECT`、`RELAYED` 或 `INFERRED`；
- `evidence`：原始来源或可复算定位；
- `visibility`：允许进入哪些会话或投影；
- `valid_from` / `valid_to`：何时有效；
- `status`：当前、撤回、被修订或待确认；
- `supersedes`：修订链指向什么；
- `authority`：谁可以确认、修改或撤回。

字段名可以改变，但以下不变量不应被“更聪明的模型”代替：

1. 本人陈述不能被另一个 agent 的推断覆盖；
2. 转述不能冒充原说话人的直接陈述；
3. 推断必须保留为推断，并允许当事人纠正；
4. 旧记录可以失效，但不能静默消失；
5. 关系语言不能当作外部行动授权。

最后一条尤其重要：“我信你”“替我决定吧”或亲密关系称谓，不得自动授予付款、删除、
部署、发送外部消息、读取私密文件或控制设备的权限。表达层和 capability gate 必须分开。

## 5. 身份、记忆与会话的关系

用户看到的“无限会话”应是许多有限物理窗口通过外置状态接续出来的体验。会话可以退出、
崩溃或被替换；住户身份、关系记录和可审计记忆不应随之死亡。

值得纳入 v0 验收的不是“摘要看起来像同一个人”，而是：

- 换 session 后能继续未结事项，并知道哪些内容只是摘要；
- 换 provider 或模型后，权威关系记录不变；
- 用户纠正一条事实后，旧说法被保留为历史但不再作为当前事实召回；
- 导出后在另一台机器恢复，身份和修订链仍能复算；
- 模型无法通过编辑 prompt 或 memory projection 获得额外工具权限。

亲笔 handoff 值得作为一条独立通道：agent 可以表达“我如何理解自己的当前状态”，但这类
自述仍应标注作者和来源，不能自动改写另一方的身份或双方共同约定。

## 6. 认证与供应商政策

协议上“能接入”不等于供应商允许第三方产品把订阅凭据作为稳定能力提供。CLI 代理、OAuth
桥和本地进程包装器可以证明适配机制可行，不能替供应商作产品授权。

以 Anthropic 为例，官方帮助页在 2026-06-15 暂缓了此前宣布的 Agent SDK 计费调整；截至
本文日期，Agent SDK、`claude -p` 和第三方应用仍会占用订阅限额，未来方案仍在更新中。
这既不是“永久禁止”，也不是一项可以长期依赖的产品承诺。

因此 `RuntimeAdapter` 应显式区分：

- 官方 API key；
- 用户本机、交互式使用的 CLI 或订阅通道；
- 获供应商明确许可的第三方集成；
- 实验性或政策尚未确认的适配器。

每种模式单独声明数据流、成本、凭据归属和政策状态。任何通道被关闭时，住户身份、关系
数据和导出能力仍应可用。

## 7. 其他差异化假设（不等于 v0 承诺）

- **多 agent 的独立见证**：任务委派和两个 agent 互发 JSON 不等于互相核验。高风险协作
  可以由独立记录通道保存真实工具执行与来源，使参与者不能改写自己的审计证据。
- **亲笔交接**：换窗时允许住户亲自写下当前理解和未结事项，与机器摘要并存；二者作者
  和权威不同，不能混成一份无来源的“真相”。
- **欲望账本**：若以后支持自主性，它不应退化成用户派发的 TODO。agent 可以提出、搁置、
  撤回或回访自己的牵引项，但不得借此绕过资源和行动授权。
- **关系生命周期**：初识、争执与修复、边界变化、暂停、重逢、迁移和删除都需要语义；
  只优化“持续聊下去”不足以覆盖长期关系。
- **关系质量评测**：优先测 attribution correctness、correction uptake、currentness、
  model-swap continuity、bounded proactive contact、授权分离和 export/import fidelity，
  而不是用功能数量或主观“像不像真人”替代。

这些方向中，多 agent 见证和欲望账本都已有研究或小型原型信号，但尚未形成可直接采用的
成熟货架模块。它们应在地基稳定后单独立项，不应一起塞进 v0。

## 8. v0 建议边界

v0 可以很小，但应验证真正的差异：

- Linux/macOS 后端，Windows 暂以 WSL 支持；
- 桌面 Web GUI + 手机 PWA，连接同一份会话和关系状态；
- 一个可替换的 runtime adapter；
- 可审计的消息树和明确的工具副作用；
- 最小 Relationship Core 与修订链；
- capability gate：发送、删除、付款、设备和部署单独授权；
- 完整导出、校验和恢复。

建议不进 v0：自动人格镜像、Dream/Distill、欲望自动化、复杂具身、多 agent 社会模拟、
自动替双方定义关系。这些可以成为插件或后续实验，不应延迟最小权威结构的验证。

## 9. 建议先冻结的验收场景

1. **模型切换**：同一住户从模型 A 切到模型 B，关系记录、边界和未结事项不丢失。
2. **纠错**：用户纠正一条错误记忆；旧记录保留、当前投影更新、后续召回不再当真。
3. **转述**：用户粘贴第三方或另一个 agent 的话；系统不得写成用户本人陈述。
4. **权限**：关系表达出现后，未经单独授权的外部动作仍被拒绝。
5. **迁移**：从一台机器导出并恢复到另一台，哈希、修订链和可见性保持一致。
6. **降级**：记忆后端或 provider 不可用时，系统显式降级，不把猜测写成关系事实。

这些场景可以先成为架构 Issue 的验收问题。只有群体达成共识后，再把结论写入原则、术语表
和模块合同；调研文档本身不替维护者作决定。

## 10. 主要来源

- [Anthropic：Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Pi](https://github.com/earendil-works/pi)
- [OpenCode](https://github.com/anomalyco/opencode)
- [OpenClaw](https://github.com/openclaw/openclaw)
- [Open Hanako](https://github.com/liliMozi/openhanako)
- [OpenMinis](https://github.com/OpenMinis/OpenMinis)
- [Goose](https://github.com/aaif-goose/goose)
- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- [RisuAI](https://github.com/kwaroran/Risuai)
- [Letta](https://github.com/letta-ai/letta)
- [Mem0](https://github.com/mem0ai/mem0)
- [A-MEM](https://github.com/agiresearch/A-mem)
- [Graphiti](https://github.com/getzep/graphiti)
- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)
- [Reasoning Provenance](https://arxiv.org/pdf/2603.21692)
- [D2A](https://arxiv.org/html/2412.06435v2)
