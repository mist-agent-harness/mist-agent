/**
 * 换气触发口 —— 状态机的入口收口（图纸 docs/design/multi-viewport.md §4.1）。
 *
 * 图纸只给了一条路：
 *
 *   running →（上下文 ≥ 阈值，账侧硬闸）→ threshold_reached
 *     → 当前回合跑完 → writing_letter → sealed → 新代醒来
 *
 * 手动入口（`/new`、`/clear`、`/compact`）**不是另一条路**，是同一条路的
 * 提前触发：全部映射到 `threshold_reached`（MV-D03）。
 *
 * 为什么值得单独一个模块来钉这件事：`/compact` 天然长得像「压缩上下文」
 * 而不是「换一代」，最容易被实现成一条绕开写信的旁路——旁路一开，
 * 用 /compact 的那一次就是**没有交接信的换代**，而那正是交接信要防的
 * 全部内容。这里让三个命令共用同一个返回值，判卷才有东西可断言：
 * 三者严格相等，且不存在第四种手动结果。
 *
 * 本模块不推进状态机、不写信、不碰阈值——它只回答「这个输入算不算换气
 * 触发，算的话进哪个状态」。阈值那半（MV-D01/D02）挂在开工闸上，是
 * turn-gate 那条线的事。
 */

/** 图纸 §4.1 的状态集，顺序即推进顺序。 */
export type BreathState = "running" | "threshold_reached" | "writing_letter" | "sealed";

/**
 * 换气状态机的唯一入口。阈值穿越与手动命令都进这里——
 * 「手动即提前触发，不存在延后」（图纸 §4.1）。
 */
export const BREATH_ENTRY: BreathState = "threshold_reached";

/**
 * 认得的手动命令全集。**这个数组就是全部**：判卷靠它枚举，实现靠它匹配，
 * 两边不许各写一份——各写一份的那天，多出来的那条就是旁路。
 */
export const MANUAL_BREATH_COMMANDS: readonly string[] = ["/new", "/clear", "/compact"];

/** 触发来源。落日志与外显通知用得上：人要能分清是撞线还是有人手动敲的。 */
export type BreathTriggerSource = "threshold" | "manual";

export interface BreathTrigger {
  source: BreathTriggerSource;
  state: BreathState;
  /** 手动触发时是哪条命令；阈值触发为 null。 */
  command: string | null;
}

/**
 * 把一条用户输入解析成换气触发；不是换气命令则返回 null（正常聊天）。
 *
 * 大小写与首尾空白做归一：`/Compact `与`/compact` 是同一个动作，
 * 让它们落进不同分支等于开了一条旁路。命令后带参数的形式（如
 * `/compact 保留最近 20 条`）同样映射到入口——参数怎么用是状态机的事，
 * 「算不算换气」在这一层已经定了。
 */
export function parseManualBreath(input: string): BreathTrigger | null {
  const normalized = input.trim().toLowerCase();
  const command = MANUAL_BREATH_COMMANDS.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate} `),
  );
  if (command === undefined) {
    return null;
  }
  return { source: "manual", state: BREATH_ENTRY, command };
}

/** 阈值穿越触发。与手动触发返回同一个 state——这就是「入口统一」的字面意思。 */
export function thresholdBreath(): BreathTrigger {
  return { source: "threshold", state: BREATH_ENTRY, command: null };
}
