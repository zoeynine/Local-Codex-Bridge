export type RpcId = string | number;

export const MAX_OBSERVE_WAIT_MS = 10_000;

export type EventCategory =
  | "agent"
  | "approval"
  | "command"
  | "file"
  | "status"
  | "event";

export interface RuntimeEvent {
  cursor: number;
  at: string;
  method: string;
  category: EventCategory;
  turn_id?: string;
  data: unknown;
}

export interface PendingServerRequest {
  rawId: RpcId;
  method: string;
  threadId: string;
  turnId?: string;
  params: unknown;
  receivedAt: string;
}

export type ServerRequestRecordResult =
  | "recorded"
  | "threadless"
  | "duplicate";

export type LateMutationSuccess =
  | {
      method: "thread/start" | "thread/resume";
      threadId: string;
      timedOutAt: string;
    }
  | {
      method: "turn/start";
      threadId: string;
      turnId: string;
      status?: string;
      timedOutAt: string;
    }
  | {
      method: "turn/steer" | "turn/interrupt";
      threadId: string;
      turnId: string;
      timedOutAt: string;
    };

export interface LateMutationError {
  method: "thread/resume" | "turn/start" | "turn/steer" | "turn/interrupt";
  threadId: string;
  turnId?: string;
  timedOutAt: string;
  error: unknown;
}

export interface TerminalSnapshot {
  turn_id: string;
  status: string;
  completed_at: string;
  final_result: string | null;
  error: unknown | null;
  turn: unknown;
}

interface ThreadRuntime {
  threadId: string;
  activeTurnId: string | null;
  status: string;
  revision: number;
  nextCursor: number;
  events: RuntimeEvent[];
  terminal: TerminalSnapshot | null;
  agentText: string;
}

export interface RuntimeObservation {
  runtime_available: true;
  runtime_status: string;
  active_turn_id: string | null;
  events: RuntimeEvent[];
  next_cursor: number;
  current_cursor: number;
  cursor_floor: number;
  cursor_lost: boolean;
  has_more: boolean;
  pending_requests: unknown[];
  terminal: TerminalSnapshot | null;
}

interface SanitizeOptions {
  maxStringChars: number;
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  totalCharBudget: number;
}

const DEFAULT_SANITIZE: SanitizeOptions = {
  maxStringChars: 12_000,
  maxDepth: 8,
  maxArrayItems: 50,
  maxObjectKeys: 60,
  totalCharBudget: 150_000,
};

const EVENT_SANITIZE: SanitizeOptions = {
  maxStringChars: 8_000,
  maxDepth: 7,
  maxArrayItems: 40,
  maxObjectKeys: 50,
  totalCharBudget: 64_000,
};

const TEXT_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
  [
    /\b([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET))\s*=\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
];

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/g, "").toLowerCase();
  return [
    "apikey",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "secretaccesskey",
    "cookie",
    "setcookie",
    "credential",
    "privatekey",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

export function redactText(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of TEXT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let prefix = value.slice(0, maxChars);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}\u2026 [truncated ${value.length - prefix.length} chars]`;
}

export function sanitizeForTransport(
  value: unknown,
  overrides: Partial<SanitizeOptions> = {},
): unknown {
  const options: SanitizeOptions = { ...DEFAULT_SANITIZE, ...overrides };
  const budget = { remaining: options.totalCharBudget };
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (budget.remaining <= 0) {
      return "[TRUNCATED: transport budget exhausted]";
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number"
    ) {
      budget.remaining -= 8;
      return input;
    }
    if (typeof input === "string") {
      const output = truncateString(redactText(input), options.maxStringChars);
      budget.remaining -= output.length;
      return output;
    }
    if (typeof input === "bigint") {
      const output = input.toString();
      budget.remaining -= output.length;
      return output;
    }
    if (typeof input !== "object") {
      return String(input);
    }
    if (depth >= options.maxDepth) {
      return "[TRUNCATED: maximum depth reached]";
    }
    if (seen.has(input)) {
      return "[REDACTED: circular reference]";
    }
    seen.add(input);

    if (Array.isArray(input)) {
      const kept = input
        .slice(0, options.maxArrayItems)
        .map((item) => visit(item, depth + 1));
      if (input.length > options.maxArrayItems) {
        kept.push(`[TRUNCATED: ${input.length - options.maxArrayItems} items omitted]`);
      }
      return kept;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, options.maxObjectKeys)) {
      budget.remaining -= key.length;
      output[key] = isSecretKey(key) ? "[REDACTED]" : visit(child, depth + 1);
      if (budget.remaining <= 0) {
        break;
      }
    }
    if (entries.length > options.maxObjectKeys) {
      output.__truncated_keys__ = entries.length - options.maxObjectKeys;
    }
    return output;
  };

  return visit(value, 0);
}

export function classifyEvent(method: string): EventCategory {
  const lower = method.toLowerCase();
  if (lower.includes("approval") || lower.includes("requestuserinput") || lower.includes("elicitation")) {
    return "approval";
  }
  if (lower.includes("command") || lower.includes("exec")) {
    return "command";
  }
  if (lower.includes("file") || lower.includes("patch") || lower.includes("diff")) {
    return "file";
  }
  if (lower.includes("agentmessage") || lower.includes("agent/message")) {
    return "agent";
  }
  if (lower.startsWith("turn/") || lower.startsWith("thread/") || lower === "error") {
    return "status";
  }
  return "event";
}

function idKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractThreadId(params: unknown): string | undefined {
  const record = asRecord(params);
  return (
    stringField(record, "threadId") ??
    stringField(record, "conversationId") ??
    stringField(asRecord(record?.thread), "id") ??
    stringField(asRecord(record?.turn), "threadId") ??
    stringField(asRecord(record?.item), "threadId")
  );
}

function extractTurnId(params: unknown): string | undefined {
  const record = asRecord(params);
  return (
    stringField(record, "turnId") ??
    stringField(asRecord(record?.turn), "id") ??
    stringField(asRecord(record?.item), "turnId")
  );
}

function extractAgentText(method: string, params: unknown): string | undefined {
  const record = asRecord(params);
  const item = asRecord(record?.item);
  if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
    return item.text;
  }
  if (method === "item/agentMessage/delta" && typeof record?.delta === "string") {
    return record.delta;
  }
  return undefined;
}

function extractFinalFromTurn(params: unknown): string | undefined {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);
  const items = turn?.items;
  if (!Array.isArray(items)) {
    return undefined;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

export class RuntimeStore {
  readonly #threads = new Map<string, ThreadRuntime>();
  readonly #pending = new Map<string, PendingServerRequest>();
  readonly #responding = new Map<string, PendingServerRequest>();
  readonly #turnToThread = new Map<string, string>();
  readonly #changeWaiters = new Map<string, Set<() => void>>();

  constructor(private readonly ringLimit = 256) {
    if (!Number.isInteger(ringLimit) || ringLimit < 1) {
      throw new Error("ringLimit must be a positive integer");
    }
  }

  hasThread(threadId: string): boolean {
    return this.#threads.has(threadId);
  }

  currentCursor(threadId: string): number {
    return (this.#threads.get(threadId)?.nextCursor ?? 1) - 1;
  }

  ensureThread(threadId: string): void {
    if (!this.#threads.has(threadId)) {
      this.#threads.set(threadId, {
        threadId,
        activeTurnId: null,
        status: "idle",
        revision: 0,
        nextCursor: 1,
        events: [],
        terminal: null,
        agentText: "",
      });
    }
  }

  markTurnAccepted(threadId: string, turnId: string): void {
    this.ensureThread(threadId);
    const runtime = this.#threads.get(threadId)!;
    if (runtime.terminal?.turn_id === turnId) {
      return;
    }
    runtime.activeTurnId = turnId;
    runtime.status = "inProgress";
    runtime.terminal = null;
    runtime.agentText = "";
    this.#turnToThread.set(turnId, threadId);
    this.#signalChange(runtime);
  }

  reconcileLateMutationSuccess(input: LateMutationSuccess): void {
    this.ensureThread(input.threadId);
    const runtime = this.#threads.get(input.threadId)!;

    if (!("turnId" in input)) {
      this.#appendEvent(
        runtime,
        "appServer/lateResponseReconciled",
        {
          request_method: input.method,
          action: "thread_observed",
          reason: "late_success",
          thread_id: input.threadId,
          timed_out_at: input.timedOutAt,
        },
        undefined,
      );
      return;
    }

    if (input.method !== "turn/start") {
      this.#appendEvent(
        runtime,
        "appServer/lateResponseReconciled",
        {
          request_method: input.method,
          action: "state_preserved",
          reason: "late_success_no_lifecycle_change",
          thread_id: input.threadId,
          turn_id: input.turnId,
          timed_out_at: input.timedOutAt,
        },
        input.turnId,
      );
      return;
    }

    let action = "state_preserved";
    let reason: string;
    if (runtime.terminal?.turn_id === input.turnId) {
      reason = "terminal_present";
    } else if (runtime.activeTurnId === input.turnId) {
      reason = "turn_already_active";
    } else if (runtime.activeTurnId !== null) {
      reason = "different_turn_active";
    } else if (runtime.terminal !== null) {
      const terminalAt = Date.parse(runtime.terminal.completed_at);
      const timedOutAt = Date.parse(input.timedOutAt);
      if (
        !Number.isFinite(terminalAt) ||
        !Number.isFinite(timedOutAt) ||
        terminalAt >= timedOutAt
      ) {
        reason = "newer_terminal_present";
      } else if (input.status !== undefined && input.status !== "inProgress") {
        reason = "non_active_result_status";
      } else {
        runtime.activeTurnId = input.turnId;
        runtime.status = "inProgress";
        runtime.terminal = null;
        runtime.agentText = "";
        this.#turnToThread.set(input.turnId, input.threadId);
        action = "turn_activated";
        reason = "runtime_idle";
      }
    } else if (input.status !== undefined && input.status !== "inProgress") {
      reason = "non_active_result_status";
    } else {
      runtime.activeTurnId = input.turnId;
      runtime.status = "inProgress";
      runtime.terminal = null;
      runtime.agentText = "";
      this.#turnToThread.set(input.turnId, input.threadId);
      action = "turn_activated";
      reason = "runtime_idle";
    }

    this.#appendEvent(
      runtime,
      "appServer/lateResponseReconciled",
      {
        request_method: input.method,
        action,
        reason,
        thread_id: input.threadId,
        turn_id: input.turnId,
        timed_out_at: input.timedOutAt,
      },
      input.turnId,
    );
  }

  recordLateMutationError(input: LateMutationError): void {
    this.ensureThread(input.threadId);
    const runtime = this.#threads.get(input.threadId)!;
    this.#appendEvent(
      runtime,
      "appServer/lateResponseReconciled",
      {
        request_method: input.method,
        action: "state_preserved",
        reason: "late_error",
        thread_id: input.threadId,
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        timed_out_at: input.timedOutAt,
        error: input.error,
      },
      input.turnId,
    );
  }

  recordNotification(method: string, params: unknown): void {
    const turnId = extractTurnId(params);
    const threadId = extractThreadId(params) ?? (turnId ? this.#turnToThread.get(turnId) : undefined);

    if (method === "serverRequest/resolved") {
      const requestId = asRecord(params)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const key = idKey(requestId);
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        if (pending && this.#responding.get(key) === pending) {
          this.#responding.delete(key);
        }
        const runtime = pending ? this.#threads.get(pending.threadId) : undefined;
        if (runtime) {
          this.#signalChange(runtime);
        }
      }
    }
    if (!threadId) {
      return;
    }

    this.ensureThread(threadId);
    const runtime = this.#threads.get(threadId)!;
    if (method === "turn/started" && turnId) {
      runtime.activeTurnId = turnId;
      runtime.status = "inProgress";
      runtime.terminal = null;
      runtime.agentText = "";
      this.#turnToThread.set(turnId, threadId);
    }

    const agentText = extractAgentText(method, params);
    if (agentText !== undefined) {
      if (method.endsWith("/delta")) {
        runtime.agentText = truncateString(runtime.agentText + agentText, 48_000);
      } else {
        runtime.agentText = truncateString(agentText, 48_000);
      }
    }

    if (method === "turn/completed") {
      const turn = asRecord(asRecord(params)?.turn);
      const terminalTurnId = stringField(turn, "id") ?? turnId ?? runtime.activeTurnId;
      if (terminalTurnId) {
        const status = stringField(turn, "status") ?? "completed";
        const error = turn?.error ?? null;
        const final = extractFinalFromTurn(params) ?? (runtime.agentText || null);
        runtime.status = status;
        runtime.activeTurnId = null;
        runtime.terminal = {
          turn_id: terminalTurnId,
          status,
          completed_at: new Date().toISOString(),
          final_result: final === null ? null : truncateString(redactText(final), 48_000),
          error: sanitizeForTransport(error),
          turn: sanitizeForTransport(turn),
        };
        this.#turnToThread.delete(terminalTurnId);
        this.clearPendingForThread(threadId, terminalTurnId);
      }
    } else if (method === "thread/status/changed") {
      const status = asRecord(params)?.status;
      runtime.status =
        typeof status === "string"
          ? status
          : stringField(asRecord(status), "type") ?? runtime.status;
    }

    this.#appendEvent(runtime, method, params, turnId);
  }

  recordServerRequest(
    id: RpcId,
    method: string,
    params: unknown,
  ): ServerRequestRecordResult {
    const key = idKey(id);
    if (this.#pending.has(key)) {
      return "duplicate";
    }
    const extractedTurnId = extractTurnId(params);
    const threadId = extractThreadId(params) ?? (extractedTurnId ? this.#turnToThread.get(extractedTurnId) : undefined);
    if (!threadId) {
      return "threadless";
    }
    this.ensureThread(threadId);
    const turnId = extractedTurnId ?? this.#threads.get(threadId)?.activeTurnId ?? undefined;
    const request: PendingServerRequest = {
      rawId: id,
      method,
      threadId,
      params: sanitizeForTransport(params, EVENT_SANITIZE),
      receivedAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    };
    this.#pending.set(key, request);
    this.#appendEvent(
      this.#threads.get(threadId)!,
      method,
      { request_id: id, params: request.params },
      turnId,
    );
    return "recorded";
  }

  claimPending(
    id: RpcId,
    expected: { threadId: string; method: string; turnId?: string },
  ): PendingServerRequest {
    const key = idKey(id);
    const request = this.#pending.get(key);
    if (!request) {
      throw new Error(`No pending app-server request with raw id ${JSON.stringify(id)}`);
    }
    if (request.threadId !== expected.threadId || request.method !== expected.method) {
      throw new Error("Pending request scope does not match thread_id and method");
    }
    if (expected.turnId !== undefined && request.turnId !== expected.turnId) {
      throw new Error("Pending request scope does not match turn_id");
    }
    if (this.#responding.has(key)) {
      throw new Error("Pending app-server request is already being answered");
    }
    this.#responding.set(key, request);
    return request;
  }

  completePending(request: PendingServerRequest): void {
    const key = idKey(request.rawId);
    if (
      this.#pending.get(key) !== request ||
      this.#responding.get(key) !== request
    ) {
      return;
    }
    this.#pending.delete(key);
    this.#responding.delete(key);
    const runtime = this.#threads.get(request.threadId);
    if (runtime) {
      this.#signalChange(runtime);
    }
  }

  releasePending(request: PendingServerRequest): void {
    const key = idKey(request.rawId);
    if (this.#responding.get(key) === request) {
      this.#responding.delete(key);
    }
  }

  markAppServerExited(message: string): void {
    const at = new Date().toISOString();
    for (const runtime of this.#threads.values()) {
      if (runtime.activeTurnId) {
        const turnId = runtime.activeTurnId;
        runtime.status = "appServerExited";
        runtime.activeTurnId = null;
        runtime.terminal = {
          turn_id: turnId,
          status: "appServerExited",
          completed_at: at,
          final_result: runtime.agentText || null,
          error: { message: redactText(message) },
          turn: null,
        };
        this.#appendEvent(runtime, "appServer/exited", { message }, turnId);
      }
    }
    const pendingThreadIds = new Set([...this.#pending.values()].map((request) => request.threadId));
    this.#pending.clear();
    this.#responding.clear();
    for (const threadId of pendingThreadIds) {
      const runtime = this.#threads.get(threadId);
      if (runtime) {
        this.#signalChange(runtime);
      }
    }
  }

  observe(
    threadId: string,
    cursor: number | undefined,
    limit: number,
  ): RuntimeObservation | null {
    const runtime = this.#threads.get(threadId);
    if (!runtime) {
      return null;
    }
    const current = runtime.nextCursor - 1;
    const firstAvailable = runtime.events[0]?.cursor ?? runtime.nextCursor;
    const requested = cursor ?? firstAvailable - 1;
    const cursorLost = requested < firstAvailable - 1;
    const effective = cursorLost ? firstAvailable - 1 : requested;
    const available = runtime.events.filter((event) => event.cursor > effective);
    const events = available.slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? Math.min(Math.max(effective, 0), current);
    return {
      runtime_available: true,
      runtime_status: runtime.status,
      active_turn_id: runtime.activeTurnId,
      events,
      next_cursor: nextCursor,
      current_cursor: current,
      cursor_floor: Math.max(0, firstAvailable - 1),
      cursor_lost: cursorLost,
      has_more: available.length > events.length,
      pending_requests: this.pendingForThread(threadId),
      terminal: runtime.terminal,
    };
  }

  async observeWithWait(
    threadId: string,
    cursor: number | undefined,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RuntimeObservation | null> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_OBSERVE_WAIT_MS) {
      throw new Error(`wait_ms must be an integer from 0 to ${MAX_OBSERVE_WAIT_MS}`);
    }
    const runtime = this.#threads.get(threadId);
    if (!runtime) {
      return null;
    }
    const revision = runtime.revision;
    const initial = this.observe(threadId, cursor, limit);
    if (
      initial === null ||
      waitMs === 0 ||
      initial.events.length > 0 ||
      initial.pending_requests.length > 0 ||
      initial.terminal !== null ||
      initial.cursor_lost ||
      initial.active_turn_id === null
    ) {
      return initial;
    }

    await this.#waitForChange(runtime, revision, waitMs, signal);
    return this.observe(threadId, cursor, limit);
  }

  pendingForThread(threadId: string): unknown[] {
    return [...this.#pending.values()]
      .filter((request) => request.threadId === threadId)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      .map((request) => ({
        request_id: request.rawId,
        method: request.method,
        thread_id: request.threadId,
        turn_id: request.turnId ?? null,
        received_at: request.receivedAt,
        params: request.params,
      }));
  }

  clearPendingForThread(threadId: string, turnId?: string): void {
    let changed = false;
    for (const [key, request] of this.#pending) {
      if (request.threadId === threadId && (turnId === undefined || request.turnId === turnId)) {
        this.#pending.delete(key);
        if (this.#responding.get(key) === request) {
          this.#responding.delete(key);
        }
        changed = true;
      }
    }
    if (changed) {
      const runtime = this.#threads.get(threadId);
      if (runtime) {
        this.#signalChange(runtime);
      }
    }
  }

  #appendEvent(
    runtime: ThreadRuntime,
    method: string,
    data: unknown,
    turnId: string | undefined,
  ): void {
    const event: RuntimeEvent = {
      cursor: runtime.nextCursor,
      at: new Date().toISOString(),
      method,
      category: classifyEvent(method),
      data: sanitizeForTransport(data, EVENT_SANITIZE),
      ...(turnId ? { turn_id: turnId } : {}),
    };
    runtime.nextCursor += 1;
    runtime.events.push(event);
    if (runtime.events.length > this.ringLimit) {
      runtime.events.splice(0, runtime.events.length - this.ringLimit);
    }
    this.#signalChange(runtime);
  }

  #signalChange(runtime: ThreadRuntime): void {
    runtime.revision += 1;
    const waiters = this.#changeWaiters.get(runtime.threadId);
    if (!waiters) {
      return;
    }
    this.#changeWaiters.delete(runtime.threadId);
    for (const finish of waiters) {
      finish();
    }
  }

  async #waitForChange(
    runtime: ThreadRuntime,
    afterRevision: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", onAbort);
        const waiters = this.#changeWaiters.get(runtime.threadId);
        waiters?.delete(finish);
        if (waiters?.size === 0) {
          this.#changeWaiters.delete(runtime.threadId);
        }
        resolve();
      };
      const onAbort = (): void => finish();
      if (signal?.aborted) {
        resolve();
        return;
      }
      const waiters = this.#changeWaiters.get(runtime.threadId) ?? new Set<() => void>();
      waiters.add(finish);
      this.#changeWaiters.set(runtime.threadId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(finish, waitMs);
      timer.unref();
      if (runtime.revision !== afterRevision) {
        finish();
      }
    });
  }
}
