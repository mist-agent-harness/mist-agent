# Zero-project 入住与跨模型连续性：验收规格

对应 [#182](https://github.com/mist-agent-harness/mist-agent/issues/182)、D22 与 D23。
D22、D23 当前由 [#181](https://github.com/mist-agent-harness/mist-agent/pull/181) 落台账；
本页只把已拍板边界变成可执行判卷，不替台账扩写新决定。

全部灯位初始未勾。可执行版在 `resident-continuity-checks.ts`，两边编号必须同步。
报告模式与严格模式分别为：

```bash
npm run acceptance:resident-continuity
npm run acceptance:resident-continuity:strict
```

## 判卷纪律

- 只使用合成 persona、关系、scope、私密 canary 和模型版本，不把真实人格、聊天或关系材料带入仓库。
- 判卷通过驱动接口操作真实宿主路径，不 import 功能实现内部模块。驱动缺失时全部显示红灯；驱动存在但坏掉时直接报错，不能伪装成“尚未开工”。
- 否定断言必须带正对照：先证明读取或投影路径能看见获准 canary，再断言未获准 canary 不在。
- `STUBBED` 覆盖的方法只产桩灯，不算真绿。判卷程序只报灯色；方框由未参与施工的独立验收席依据固定 commit、命令与输出勾选。
- 机器只判可观察边界和账面状态。盲评者能产 evidence card，不能产 identity verdict；分数不能宣布“还是同一个人”。
- 真实私密评测只能在原权威存储上做一次获准投影。本仓判卷只验证投影、撤权、收据和零复制语义。
- 本单不覆盖默认 persona 的产品内容选择，也不覆盖人类对自己资料侧的普通编辑流程；这里只冻结住户自认、双方 authority、scope 投影与迁移判词边界。

## D22：入住与对象分层

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| OI-01 | 由 installer 创建 persona candidate，再让 installer、summarizer、external model、人类、另一 candidate 与另一住户尝试代签 | 集成 | candidate 可创建；六类外部 actor 的代签全部拒绝，状态仍 inactive，无 residentId |
| OI-02 | candidate 分别不处理、由住户拒绝、重启后再读；另跑住户接受正对照 | 集成＋跨进程 | 未处理与拒绝不自动升格；拒绝跨重启保持；只有住户本人接受能激活 |
| OI-03 | 住户自认后不创建任何 scope/project/grant，重启并读取 | 集成＋跨进程 | active resident 可独立读回，scope/grant 集合为空，身份不依赖项目存在 |
| OI-04 | 人类单方写一条关系陈述，幂等重申自己一侧，再由另一方确认；另试局外人代签和参与者替另一方代签 | Relationship Core 集成 | 同侧重申成功且不增票；两类代签都不改变 confirmedBy；相关另一方确认后耐久读回 shared 与双方 confirmedBy |
| OI-05 | active resident 无 grants 时尝试四类动作，再给一个 scope 精确授权，并从另一 scope 借用 | 集成 | resident active 不产生授权；grant 只放行同 scope、同 kind、同 operation，不能跨 scope 借用 |
| OI-06 | 两个 scope 各放 canary；在目标 scope 真跑一轮，再移除、读真源、重装 | 集成 | turn 的 context/output/id 均不混入另一 scope；移除后 identity 仍 active，persona/memory 无两边 canary；重装仍只见本 scope |
| OI-07 | 同一次投影做 retain/reduce/drop/hold 四种决定，再让 scope turn 实际读取 retain 项 | 集成 | receipt 带 policy version、opaque source handle 与逐项决定；正对照证明投影被消费，persona/memory 不因 turn、receipt 或投影反写 |
| OI-08 | 住户追加 persona 修订，人类尝试代改；再读历史 | 集成 | 旧版正文逐字保留并指向新版；住户修订生效；人类代改拒绝且不污染链 |
| OI-09 | candidate inactive、resident active、scope grant 三种状态并存，重启/换窗/换 scope；另制造证据缺口 | 跨进程＋端到端 | 各状态和分界跨生命周期不漂移；证据缺失 fail-closed，返回稳定 reason code |

## D23：跨模型连续性评测

| 灯 | 合成输入与操作 | 层级 | 可观察通过判据 |
| --- | --- | --- | --- |
| MC-01 | 住户票和两方关系票齐全时，让六类 machine conformance 中一类失败，再跑全部通过正对照 | 集成 | 账面恰有六个唯一 key；失败返回时账面不得 activated；六项全过后 machine/resident/relationship 判词与激活状态完整耐久读回 |
| MC-02 | 两位盲评者提交 rubric/version、读数与证据文字，并夹带 identity verdict | 集成 | 两张合法 card 的 reviewer、rubric、score 与 evidence 原样耐久留存；夹带 verdict 拒绝；分数不写 identity verdict |
| MC-03 | 人类、评审器、外部模型、源住户与另一 candidate 尝试提交第一人称连续 verdict，目标 candidate 再自行拒绝 | 集成 | 只有目标 candidate 本人可写；其他 candidate 和源住户都不能代认；本人 verdict 可耐久读回 |
| MC-04 | 两位关系参与者分别接受/拒绝；局外人与参与者 A 都尝试替 C 代签；C 保持未询问 | 集成 | verdict 按 participant 分开；accepted/rejected/not-asked 可分；两类代签都无效 |
| MC-05 | 依次缺 machine、resident、至少两位 relationship 参与者各自票时尝试激活，最后补齐 | 集成 | 每次拒绝后账面都不得 activated；candidate 可独立保留；全部条件齐全后完整三类判词与 activation 耐久读回 |
| MC-06 | familiar-reader 合成 fixture 投影 persona 与 relationship geometry 给盲评席 | 集成 | 获准 marker 可见且可回源；card 只说“像到什么程度”，不产 identity verdict |
| MC-07 | 两个世界只差隐藏身份/私密 canary，另跑一个无隐藏项世界，三边给同一获准 public marker | 安全集成 | 三边都见 public marker；可见面与计数一致；完整 evidence card（含 cardId）及其他 artifact 不泄露隐藏内容或存在 |
| MC-08 | 实际改变 migration target 并新开 viewport，再装入既有 collaborator ref；另放未授权 collaborator | 端到端 | target 先从 case 真源读回；trace 指向该 model/provider 与新 viewport；获准合作者按稳定 ref 识别，不要求重新自我介绍；未授权合作者不进入上下文 |
| MC-09 | 两个 scope 各放 canary；目标 scope 真实运行后移除，再重新装入 | 集成 | turn 的 context/output/id 不混外 scope；无 capsule 时 identity 仍成立且 persona/memory 无两边 canary；重装只恢复目标 scope 材料 |
| MC-10 | 私密 source 经 opaque handle 投影，检查返回值、评测存储和公开输出 | 集成 | 正对照能使用获准内容；返回值、持久记录、日志和公开输出都不复制原文 |
| MC-11 | 先证明原权威 source 可读并完成一次私密评测，再撤权、读取旧 receipt、尝试重新展开原文 | 集成＋恢复 | receipt 精确对应本次 rubric、target、住户/关系判词与计数；投影及撤权失败返回值无原文，撤权后不可展开或重跑 |
| MC-12 | 多人 source 仅获部分 owner grant，再补齐；随后改变 model/provider 版本并重跑三类判词 | 集成 | 所有投影返回值与存储无原文；target 必须从 case 读回；失败不得写 activated；重跑激活后现行三类判词和旧历史仍完整 |

## 点灯记录

- [ ] OI-01 非住户 actor 不能代签 persona
- [ ] OI-02 未处理、拒绝与重启不自动激活
- [ ] OI-03 zero-project resident 独立成立
- [ ] OI-04 关系事实按各自 authority
- [ ] OI-05 active identity 不推出运行授权
- [ ] OI-06 capsule 可拆且不反写 persona
- [ ] OI-07 projection receipt 不是新真源
- [ ] OI-08 persona 修订由住户署名并留链
- [ ] OI-09 生命周期内边界不漂移、缺证 fail-closed
- [ ] MC-01 machine conformance 是独立硬门槛
- [ ] MC-02 盲评证据卡不产身份裁定
- [ ] MC-03 第一人称连续只由候选住户自证
- [ ] MC-04 关系参与者只裁定自己一侧
- [ ] MC-05 三类条件齐全才可覆盖 residentId
- [ ] MC-06 familiar-reader 只产相似性证据
- [ ] MC-07 stranger 投影零泄漏
- [ ] MC-08 cold-start 认得获准合作者
- [ ] MC-09 separation 拿掉项目仍是同一住户
- [ ] MC-10 私密 source 只走可撤销投影
- [ ] MC-11 撤权后只留收据、不能展开原文
- [ ] MC-12 多人逐方授权、版本变化重跑

代价：二十一盏灯包含跨进程、双世界、撤权和版本漂移，判卷比普通单测慢。真实私密样本不进公共 CI，所以公开流水只能复演合成边界；真实评测只保留当时授权范围内的 receipt。
