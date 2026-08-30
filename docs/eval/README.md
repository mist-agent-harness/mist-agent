# docs/eval/ —— 评测的判卷标准

这个目录只放**人工判卷标准**，一份标准一个文件，文件名带版本号。

| 文件 | 判什么 | 状态 |
|---|---|---|
| [rubric-v0.1.3.md](rubric-v0.1.3.md) | 小机可读性零上下文自维修评测的 G1 / G3 / G6 盲评面，加 G4 的③④ | 现行 |
| [rubric-v0.1.2.md](rubric-v0.1.2.md) | 同上；假写 gate 的罚则误挂进六条硬红线（红线的对象是 candidate，不是评审记录） | 已被 v0.1.3 取代，原地不改不删 |
| [rubric-v0.1.1.md](rubric-v0.1.1.md) | 同上；escalation 只写了怎么提，没写验收席怎么处置 | 已被 v0.1.2 取代，原地不改不删 |
| [rubric-v0.1.0.md](rubric-v0.1.0.md) | 同上；仲裁人回避一节漏抄两条客观禁入 | 已被 v0.1.1 取代，原地不改不删 |

判什么由冻结契约定，见
[docs/design/resident-self-repair-eval-v0.md](../design/resident-self-repair-eval-v0.md)（v0 frozen）。
本目录只定「人怎么判」，与冻结契约冲突时以冻结契约为准。

规矩三条：

- **版本号即身份**。runner 写进 `semantic_review/` 的 `rubric_version` 必须与文件里那个
  字符串逐字一致；
- **旧版号不得复用**。判据有实质改动就升版，旧文件留在原地不改不删；
- **确定性 gate 不进这里**。runner 从 trace 自动判的东西归 runner，
  同一个 gate 只能有一个判卷主体。

具体判据、程序、回避规则、硬红线，全在各版本文件正文里，本 README 不复述——
复述就是第二本账。
