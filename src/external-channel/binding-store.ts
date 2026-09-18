import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ExternalChannelAddress {
  readonly pluginId: string;
  readonly channelId: string;
}

export interface ExternalChannelBinding {
  readonly bindingId: string;
  readonly residentId: string;
  readonly scopeId: string;
  readonly address: ExternalChannelAddress;
  readonly boundAt: string;
}

export interface BindingAuditEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly operation: "bound" | "revoked";
  readonly residentId: string;
  readonly scopeId: string;
  readonly address: ExternalChannelAddress;
  readonly at: string;
  readonly reason?: string;
}

export interface ExternalChannelBindingStoreOptions {
  readonly journalPath: string;
  readonly now?: () => number;
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function addressKey(address: ExternalChannelAddress): string {
  return JSON.stringify([address.pluginId, address.channelId]);
}

function ownerKey(residentId: string, scopeId: string): string {
  return JSON.stringify([residentId, scopeId]);
}

function cloneAddress(address: ExternalChannelAddress): ExternalChannelAddress {
  return { pluginId: address.pluginId, channelId: address.channelId };
}

function cloneBinding(binding: ExternalChannelBinding): ExternalChannelBinding {
  return { ...binding, address: cloneAddress(binding.address) };
}

function parseEvent(line: string, lineNumber: number): BindingAuditEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`invalid external binding journal JSON at line ${lineNumber}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid external binding event at line ${lineNumber}`);
  }
  const event = value as Partial<BindingAuditEvent> & {
    address?: Partial<ExternalChannelAddress>;
  };
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.sequence) ||
    Number(event.sequence) < 1 ||
    (event.operation !== "bound" && event.operation !== "revoked") ||
    typeof event.residentId !== "string" ||
    event.residentId.length === 0 ||
    typeof event.scopeId !== "string" ||
    event.scopeId.length === 0 ||
    typeof event.address?.pluginId !== "string" ||
    event.address.pluginId.length === 0 ||
    typeof event.address.channelId !== "string" ||
    event.address.channelId.length === 0 ||
    typeof event.at !== "string" ||
    (event.operation === "revoked" &&
      (typeof event.reason !== "string" || event.reason.trim().length === 0))
  ) {
    throw new Error(`invalid external binding event at line ${lineNumber}`);
  }
  return {
    schemaVersion: 1,
    sequence: Number(event.sequence),
    operation: event.operation,
    residentId: event.residentId,
    scopeId: event.scopeId,
    address: {
      pluginId: event.address.pluginId,
      channelId: event.address.channelId,
    },
    at: event.at,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
}

/** Independent, append-only authority for external address -> resident scope resolution. */
export class ExternalChannelBindingStore {
  readonly #journalPath: string;
  readonly #now: () => number;
  readonly #byAddress = new Map<string, ExternalChannelBinding>();
  readonly #byOwner = new Map<string, Map<string, ExternalChannelBinding>>();
  readonly #audit: BindingAuditEvent[] = [];
  #sequence = 0;

  constructor(options: ExternalChannelBindingStoreOptions) {
    this.#journalPath = options.journalPath;
    this.#now = options.now ?? Date.now;
    mkdirSync(dirname(this.#journalPath), { recursive: true });
    if (!existsSync(this.#journalPath)) return;
    const events = readFileSync(this.#journalPath, "utf8")
      .split("\n")
      .flatMap((line, index) => (line.trim().length === 0 ? [] : [parseEvent(line, index + 1)]));
    for (const event of events) {
      if (event.sequence !== this.#sequence + 1) {
        throw new Error(`external binding journal sequence gap at ${event.sequence}`);
      }
      this.#sequence = event.sequence;
      this.#audit.push(event);
      this.#apply(event);
    }
  }

  bind(input: {
    residentId: string;
    scopeId: string;
    address: ExternalChannelAddress;
  }): ExternalChannelBinding {
    const residentId = nonempty(input.residentId, "residentId");
    const scopeId = nonempty(input.scopeId, "scopeId");
    const address = {
      pluginId: nonempty(input.address.pluginId, "pluginId"),
      channelId: nonempty(input.address.channelId, "channelId"),
    };
    const existing = this.#byAddress.get(addressKey(address));
    if (existing !== undefined) {
      if (existing.residentId === residentId && existing.scopeId === scopeId) {
        return cloneBinding(existing);
      }
      throw new Error(
        `external address already bound to ${existing.residentId}/${existing.scopeId}`,
      );
    }
    const event: BindingAuditEvent = {
      schemaVersion: 1,
      sequence: this.#sequence + 1,
      operation: "bound",
      residentId,
      scopeId,
      address,
      at: new Date(this.#now()).toISOString(),
    };
    this.#append(event);
    this.#apply(event);
    this.#audit.push(event);
    this.#sequence = event.sequence;
    return cloneBinding(this.#byAddress.get(addressKey(address)) as ExternalChannelBinding);
  }

  revoke(
    input: {
      residentId: string;
      scopeId: string;
      address: ExternalChannelAddress;
    },
    reason: string,
  ): void {
    nonempty(reason, "revocation reason");
    const existing = this.#byAddress.get(addressKey(input.address));
    if (
      existing === undefined ||
      existing.residentId !== input.residentId ||
      existing.scopeId !== input.scopeId
    ) {
      throw new Error("external binding does not exist for that resident scope");
    }
    const event: BindingAuditEvent = {
      schemaVersion: 1,
      sequence: this.#sequence + 1,
      operation: "revoked",
      residentId: existing.residentId,
      scopeId: existing.scopeId,
      address: cloneAddress(existing.address),
      at: new Date(this.#now()).toISOString(),
      reason,
    };
    this.#append(event);
    this.#apply(event);
    this.#audit.push(event);
    this.#sequence = event.sequence;
  }

  resolve(address: ExternalChannelAddress): ExternalChannelBinding | undefined {
    const binding = this.#byAddress.get(addressKey(address));
    return binding === undefined ? undefined : cloneBinding(binding);
  }

  bindingsFor(residentId: string, scopeId: string): ExternalChannelBinding[] {
    return [...(this.#byOwner.get(ownerKey(residentId, scopeId))?.values() ?? [])].map(
      cloneBinding,
    );
  }

  activeBindings(): ExternalChannelBinding[] {
    return [...this.#byAddress.values()].map(cloneBinding);
  }

  auditTrail(residentId?: string, scopeId?: string): BindingAuditEvent[] {
    return this.#audit
      .filter(
        (event) =>
          (residentId === undefined || event.residentId === residentId) &&
          (scopeId === undefined || event.scopeId === scopeId),
      )
      .map((event) => ({ ...event, address: cloneAddress(event.address) }));
  }

  #append(event: BindingAuditEvent): void {
    appendFileSync(this.#journalPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  #apply(event: BindingAuditEvent): void {
    const aKey = addressKey(event.address);
    const oKey = ownerKey(event.residentId, event.scopeId);
    if (event.operation === "bound") {
      const conflict = this.#byAddress.get(aKey);
      if (conflict !== undefined) {
        throw new Error(`duplicate or ambiguous external binding at sequence ${event.sequence}`);
      }
      const binding: ExternalChannelBinding = {
        bindingId: `binding-${event.sequence.toString(36).padStart(8, "0")}`,
        residentId: event.residentId,
        scopeId: event.scopeId,
        address: cloneAddress(event.address),
        boundAt: event.at,
      };
      this.#byAddress.set(aKey, binding);
      const owner = this.#byOwner.get(oKey) ?? new Map<string, ExternalChannelBinding>();
      owner.set(aKey, binding);
      this.#byOwner.set(oKey, owner);
      return;
    }
    const current = this.#byAddress.get(aKey);
    if (
      current === undefined ||
      current.residentId !== event.residentId ||
      current.scopeId !== event.scopeId
    ) {
      throw new Error(`revocation has no matching external binding at sequence ${event.sequence}`);
    }
    this.#byAddress.delete(aKey);
    const owner = this.#byOwner.get(oKey);
    owner?.delete(aKey);
    if (owner?.size === 0) this.#byOwner.delete(oKey);
  }
}
