/**
 * 住户的单线聊天 TUI 控制器（D28 / RT-05）。
 *
 * 只画一条主流，不维护会话列表；增量直接取自 ResidentRuntime.say() 的模型流，
 * 不把最终回复切片伪装成流式输出。终端 CLI 与宿主验收脚本共用本控制器。
 */
import type {
  ChannelSpec,
  Result,
  TuiFrame,
  TuiStep,
  TuiTranscript,
  TurnResult,
} from "../../acceptance/resident-runtime-driver.ts";

export interface ChatTurnPort {
  say(input: {
    readonly residentId: string;
    readonly text: string;
    readonly onChunk?: (chunk: string) => void;
  }): Promise<Result<TurnResult>>;
}

export interface ScriptedChatPort extends ChatTurnPort {
  revokeCredential(input: { residentId: string }): void;
}

export interface ResidentChatTuiOptions {
  readonly residentId: string;
  readonly model: string;
  readonly onFrame?: (frame: TuiFrame) => void;
}

/** 单住户、单模型状态栏与逐增量重绘。 */
export class ResidentChatTui {
  readonly #runtime: ChatTurnPort;
  readonly #residentId: string;
  #model: string;
  readonly #onFrame: ((frame: TuiFrame) => void) | undefined;
  readonly #messages: string[] = [];
  readonly #frames: TuiFrame[] = [];
  readonly #streamChunks: string[] = [];
  #errorText: string | null = null;
  #frameClock = 0;
  #started = false;

  constructor(runtime: ChatTurnPort, options: ResidentChatTuiOptions) {
    this.#runtime = runtime;
    this.#residentId = options.residentId;
    this.#model = options.model;
    this.#onFrame = options.onFrame;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#draw();
  }

  async submit(text: string): Promise<Result<TurnResult>> {
    this.start();
    this.#errorText = null;
    const messageIndex = this.#messages.length;
    this.#messages.push(`你：${text}\n住户：`);
    this.#draw();

    let streamedReply = "";
    let result: Result<TurnResult>;
    try {
      result = await this.#runtime.say({
        residentId: this.#residentId,
        text,
        onChunk: (chunk) => {
          if (chunk.length === 0) return;
          streamedReply += chunk;
          this.#streamChunks.push(chunk);
          this.#messages[messageIndex] = `你：${text}\n住户：${streamedReply}`;
          this.#draw();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知终端错误";
      result = {
        ok: false,
        error: {
          code: "tui-unavailable",
          message: `终端回合失败：${message}`,
          remedy: "检查住户运行时与终端输出后重试",
          residentId: this.#residentId,
        },
      };
    }

    if (!result.ok) {
      this.#errorText = `${result.error.code}：${result.error.message}\n处理建议：${result.error.remedy}`;
      this.#messages[messageIndex] = `你：${text}\n[错误]\n${this.#errorText}`;
      this.#draw();
      return result;
    }

    this.#model = result.value.model;
    if (streamedReply.length === 0) {
      // 幂等回放没有重新调用模型，准确显示已落账结果，但不虚报增量数量。
      this.#messages[messageIndex] = `你：${text}\n住户：${result.value.reply}`;
      this.#draw();
    } else if (streamedReply !== result.value.reply) {
      const mismatch: Result<TurnResult> = {
        ok: false,
        error: {
          code: "tui-unavailable",
          message: "终端收到的流式片段与已落账回复不一致",
          remedy: "检查模型传输增量与回合最终结果的一致性",
          residentId: this.#residentId,
        },
      };
      this.#errorText = `${mismatch.error.code}：${mismatch.error.message}\n处理建议：${mismatch.error.remedy}`;
      this.#messages[messageIndex] = `你：${text}\n[错误]\n${this.#errorText}`;
      this.#draw();
      return mismatch;
    }
    return result;
  }

  transcript(): TuiTranscript {
    return {
      frames: this.#frames.map((frame) => ({ ...frame })),
      statusResidentId: this.#residentId,
      statusModel: this.#model,
      streamChunks: [...this.#streamChunks],
      errorText: this.#errorText,
    };
  }

  #draw(): void {
    const body = this.#messages.length === 0 ? "" : `\n\n${this.#messages.join("\n\n")}`;
    const frame: TuiFrame = {
      atMs: this.#frameClock,
      text: `住户：${this.#residentId}　模型：${this.#model}${body}`,
      sessionCount: 1,
    };
    this.#frameClock += 1;
    this.#frames.push(frame);
    this.#onFrame?.(frame);
  }
}

/** 由真实宿主驱动脚本化 TUI；breakChannel 撤销实际凭证，再让正常 say() 路径报错。 */
export async function runResidentTuiScript(
  runtime: ScriptedChatPort,
  input: {
    readonly residentId: string;
    readonly channel: ChannelSpec;
    readonly script: readonly TuiStep[];
  },
): Promise<Result<TuiTranscript>> {
  try {
    const tui = new ResidentChatTui(runtime, {
      residentId: input.residentId,
      model: input.channel.model,
    });
    tui.start();
    for (const step of input.script) {
      if (step.kind === "breakChannel") {
        runtime.revokeCredential({ residentId: input.residentId });
        continue;
      }
      await tui.submit(step.text);
    }
    return { ok: true, value: tui.transcript() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知终端错误";
    return {
      ok: false,
      error: {
        code: "tui-unavailable",
        message: `终端界面无法运行：${message}`,
        remedy: "检查住户 ID、终端状态与住户运行时后重试",
        residentId: input.residentId,
      },
    };
  }
}
