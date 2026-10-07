import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

/** 原模型请求的认证交付边界；不保存事实正文或可复活的 authority。 */
export interface TurnLedgerTarget {
  readonly residentId: string;
  readonly scopeId: string;
  readonly scopeGeneration: number;
  readonly windowId: string;
  readonly generation: number;
  readonly dispatchId: string;
  readonly targetSeq: number;
}

interface ConfirmedTurn {
  readonly turnId: string;
  readonly assistantEventId: string;
  readonly streamSeq: number;
  readonly target: TurnLedgerTarget;
}

export function readTurnLedgerTarget(value: unknown): TurnLedgerTarget {
  if (typeof value !== "object" || value === null) throw new Error("invalid turn ledger target");
  const target = value as Record<string, unknown>;
  if (
    typeof target.residentId !== "string" ||
    typeof target.scopeId !== "string" ||
    typeof target.windowId !== "string" ||
    typeof target.dispatchId !== "string" ||
    typeof target.scopeGeneration !== "number" ||
    !Number.isInteger(target.scopeGeneration) ||
    typeof target.generation !== "number" ||
    !Number.isInteger(target.generation) ||
    typeof target.targetSeq !== "number" ||
    !Number.isInteger(target.targetSeq) ||
    target.targetSeq < 0
  )
    throw new Error("invalid turn ledger target");
  return {
    residentId: target.residentId,
    scopeId: target.scopeId,
    scopeGeneration: target.scopeGeneration,
    windowId: target.windowId,
    generation: target.generation,
    dispatchId: target.dispatchId,
    targetSeq: target.targetSeq,
  };
}

/** 只记录真实 ACK 后的元数据。正文及交付目标仍以 canonical assistant 事件为准。 */
export class TurnReceiptStore {
  constructor(readonly directory: string) {}

  #read(residentId: string): ConfirmedTurn[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.directory, `${residentId}.turns.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const file = JSON.parse(raw) as { schemaVersion?: unknown; turns?: unknown };
    if (file.schemaVersion !== 1 || !Array.isArray(file.turns))
      throw new Error("invalid turn receipt file");
    return file.turns.map((value: unknown) => {
      if (typeof value !== "object" || value === null) throw new Error("invalid confirmed turn");
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.turnId !== "string" ||
        typeof entry.assistantEventId !== "string" ||
        typeof entry.streamSeq !== "number" ||
        !Number.isInteger(entry.streamSeq)
      ) {
        throw new Error("invalid confirmed turn");
      }
      const target = readTurnLedgerTarget(entry.target);
      if (target.residentId !== residentId)
        throw new Error("turn receipt belongs to another resident");
      return {
        turnId: entry.turnId,
        assistantEventId: entry.assistantEventId,
        streamSeq: entry.streamSeq,
        target,
      };
    });
  }

  confirms(
    residentId: string,
    turnId: string,
    assistantEventId: string,
    streamSeq: number,
    target: TurnLedgerTarget,
  ): boolean {
    return this.#read(residentId).some((entry) => {
      const delivered = entry.target;
      const sameIdentity =
        delivered.residentId === target.residentId &&
        delivered.scopeId === target.scopeId &&
        delivered.scopeGeneration === target.scopeGeneration &&
        delivered.windowId === target.windowId &&
        delivered.generation === target.generation;
      if (!sameIdentity || delivered.targetSeq < target.targetSeq) return false;
      if (entry.turnId === turnId)
        return (
          entry.assistantEventId === assistantEventId &&
          entry.streamSeq === streamSeq &&
          delivered.dispatchId === target.dispatchId &&
          delivered.targetSeq === target.targetSeq
        );
      // 另一回合只能凭后续真实交付覆盖原 target；登记 baseline 和更早的回执均不算。
      return entry.streamSeq > streamSeq;
    });
  }

  record(residentId: string, entry: ConfirmedTurn): void {
    const turns = this.#read(residentId).filter((existing) => existing.turnId !== entry.turnId);
    turns.push(entry);
    const path = join(this.directory, `${residentId}.turns.json`);
    const temporary = `${path}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      writeSync(descriptor, JSON.stringify({ schemaVersion: 1, turns }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  }
}
