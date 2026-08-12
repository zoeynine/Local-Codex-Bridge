import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";

import {
  RuntimeStore,
  redactText,
  sanitizeForTransport,
  type RpcId,
} from "./runtime.js";

const MAX_JSONL_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LATE_RESPONSE_TTL_MS = 60_000;
const DEFAULT_LATE_RESPONSE_LIMIT = 256;
const MAX_SCOPE_ID_CHARS = 200;
const THREADLESS_REQUEST_ERROR = {
  code: -32601,
  message: "Unsupported app-server request without thread context",
} as const;
const MUTATING_REQUEST_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type LateResponseCandidate =
  | { method: "thread/start" }
  | { method: "thread/resume"; requestedThreadId: string }
  | { method: "turn/start"; requestedThreadId: string }
  | {
      method: "turn/steer" | "turn/interrupt";
      requestedThreadId: string;
      requestedTurnId: string;
    };

interface RetainedLateResponse {
  candidate: LateResponseCandidate;
  timedOutAt: string;
  expiresAtMs: number;
}

export interface AppServerLaunchOptions {
  executable?: string;
  prefixArgs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  lateResponseTtlMs?: number;
  lateResponseLimit?: number;
}

function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedScopeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_ID_CHARS
    ? value
    : undefined;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function lateResponseCandidate(
  method: string,
  params: unknown,
): LateResponseCandidate | undefined {
  if (method === "thread/start") {
    return { method };
  }
  const record = asRecord(params);
  if (method === "turn/steer" || method === "turn/interrupt") {
    const requestedThreadId = boundedScopeId(record?.threadId);
    const requestedTurnId = boundedScopeId(
      method === "turn/steer" ? record?.expectedTurnId : record?.turnId,
    );
    return requestedThreadId && requestedTurnId
      ? { method, requestedThreadId, requestedTurnId }
      : undefined;
  }
  if (method !== "thread/resume" && method !== "turn/start") {
    return undefined;
  }
  const requestedThreadId = boundedScopeId(record?.threadId);
  return requestedThreadId ? { method, requestedThreadId } : undefined;
}

function messageFromUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(sanitizeForTransport(value));
  } catch {
    return String(value);
  }
}

function requestTimeoutError(method: string): Error {
  if (MUTATING_REQUEST_METHODS.has(method)) {
    return new Error(
      `Codex app-server acknowledgement timed out for already-sent mutating request ${method}; operation outcome is UNKNOWN because Codex may already have accepted it. Re-observe or read before retrying. No automatic retry is performed.`,
    );
  }
  return new Error(`Codex app-server request timed out: ${method}`);
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.CODEX_EXE?.trim();
  if (explicit) {
    if (/[\0\r\n]/.test(explicit)) {
      throw new Error("CODEX_EXE contains an invalid control character");
    }
    return explicit;
  }
  return "codex";
}

export function resolveCodexChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.CONTROL_PLANE_API_KEY;
  return childEnvironment;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export function writeWithBackpressure(
  stream: Writable,
  chunk: string,
): Promise<void> {
  if (!stream.writable || stream.writableEnded || stream.destroyed) {
    return Promise.reject(new Error("Codex app-server stdin is not writable"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackDone = false;
    let drainDone = false;

    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const maybeResolve = (): void => {
      if (!settled && writeReturned && callbackDone && drainDone) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drainDone = true;
      maybeResolve();
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void =>
      fail(new Error("Codex app-server stdin closed during write"));
    const onWrite = (error?: Error | null): void => {
      if (error) {
        fail(error);
        return;
      }
      callbackDone = true;
      maybeResolve();
    };

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      const accepted = stream.write(chunk, "utf8", onWrite);
      if (settled) {
        return;
      }
      if (accepted) {
        drainDone = true;
        stream.off("drain", onDrain);
      }
      writeReturned = true;
      maybeResolve();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error(messageFromUnknown(error)),
      );
    }
  });
}

export function createSerializedWriter(
  write: (chunk: string) => Promise<void>,
): (chunk: string) => Promise<void> {
  let tail = Promise.resolve();
  return async (chunk: string): Promise<void> => {
    const current = tail.then(() => write(chunk));
    tail = current.catch(() => undefined);
    await current;
  };
}

export class AppServerManager {
  readonly runtime: RuntimeStore;

  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #requestTimeoutMs: number;
  readonly #lateResponseTtlMs: number;
  readonly #lateResponseLimit: number;
  readonly #pendingCalls = new Map<string, PendingCall>();
  readonly #lateResponses = new Map<string, RetainedLateResponse>();
  readonly #writeLine: (chunk: string) => Promise<void>;

  #child: ChildProcessWithoutNullStreams | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #fatal: Error | null = null;
  #closing = false;
  #initialized = false;
  #nextRequestId = 1;
  #stdoutBuffer = Buffer.alloc(0);

  constructor(
    runtime = new RuntimeStore(),
    options: AppServerLaunchOptions = {},
  ) {
    this.runtime = runtime;
    const sourceEnvironment = options.environment ?? process.env;
    this.#executable = options.executable ?? resolveCodexExecutable(sourceEnvironment);
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#environment = resolveCodexChildEnvironment(sourceEnvironment);
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#lateResponseTtlMs = positiveIntegerOption(
      options.lateResponseTtlMs,
      DEFAULT_LATE_RESPONSE_TTL_MS,
      "lateResponseTtlMs",
    );
    this.#lateResponseLimit = positiveIntegerOption(
      options.lateResponseLimit,
      DEFAULT_LATE_RESPONSE_LIMIT,
      "lateResponseLimit",
    );
    this.#writeLine = createSerializedWriter(async (chunk) => {
      const child = this.#child;
      if (
        this.#closing ||
        this.#fatal ||
        !child ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("Codex app-server stdin is not writable");
      }
      await writeWithBackpressure(child.stdin, chunk);
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureReady();
    return await this.#request(method, params, this.#requestTimeoutMs);
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    await this.ensureReady();
    await this.#write({ id, result });
  }

  async ensureReady(): Promise<void> {
    if (this.#closing) {
      throw new Error("Codex app-server manager is closing");
    }
    if (this.#fatal) {
      throw new Error(
        `Codex app-server is unavailable and will not be auto-restarted: ${this.#fatal.message}`,
      );
    }
    if (this.#initialized && this.#child) {
      return;
    }
    if (!this.#startPromise) {
      this.#startPromise = this.#start();
    }
    await this.#startPromise;
  }

  async close(): Promise<void> {
    if (this.#closePromise) {
      return await this.#closePromise;
    }
    this.#closePromise = this.#close();
    return await this.#closePromise;
  }

  async #start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#executable,
        [...this.#prefixArgs, "app-server", "--listen", "stdio://"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: this.#environment,
        },
      );
    } catch (error) {
      this.#fatal = new Error(
        `Failed to spawn ${this.#executable}: ${redactText(messageFromUnknown(error))}`,
      );
      throw this.#fatal;
    }

    this.#child = child;
    child.stdin.on("error", (error) => this.#onStdinError(child, error));
    child.stdin.once("close", () => this.#onStdinClose(child));
    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", () => {
      // Drain without forwarding potentially sensitive child diagnostics.
    });
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      child.on("error", (error) => this.#onChildError(child, error));

      await this.#request(
        "initialize",
        {
          clientInfo: {
            name: "local-codex-bridge",
            title: "Local Codex Bridge",
            version: "2.1.2",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        },
        30_000,
      );
      await this.#write({ method: "initialized", params: {} });
      this.#initialized = true;
    } catch (error) {
      const failure =
        this.#fatal ??
        new Error(`Codex app-server initialization failed: ${redactText(messageFromUnknown(error))}`);
      this.#fatal = failure;
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        if (!(await waitForExit(child, 500))) {
          child.kill();
        }
      }
      throw failure;
    }
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = rpcKey(id);
    const lateCandidate = lateResponseCandidate(method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingCalls.delete(key)) {
          return;
        }
        if (lateCandidate) {
          this.#retainLateResponse(key, lateCandidate);
        }
        reject(requestTimeoutError(method));
      }, timeoutMs);
      this.#pendingCalls.set(key, { method, resolve, reject, timer });
      void this.#write({ method, id, params }).catch((error: unknown) => {
        const pending = this.#pendingCalls.get(key);
        if (!pending) {
          this.#lateResponses.delete(key);
          return;
        }
        clearTimeout(pending.timer);
        this.#pendingCalls.delete(key);
        pending.reject(
          new Error(`Failed to write app-server request ${method}: ${messageFromUnknown(error)}`),
        );
      });
    });
  }

  #retainLateResponse(key: string, candidate: LateResponseCandidate): void {
    const now = Date.now();
    for (const [retainedKey, retained] of this.#lateResponses) {
      if (retained.expiresAtMs <= now) {
        this.#lateResponses.delete(retainedKey);
      }
    }
    while (this.#lateResponses.size >= this.#lateResponseLimit) {
      const oldest = this.#lateResponses.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#lateResponses.delete(oldest);
    }
    this.#lateResponses.set(key, {
      candidate,
      timedOutAt: new Date(now).toISOString(),
      expiresAtMs: now + this.#lateResponseTtlMs,
    });
  }

  #takeLateResponse(key: string): RetainedLateResponse | undefined {
    const retained = this.#lateResponses.get(key);
    if (!retained) {
      return undefined;
    }
    this.#lateResponses.delete(key);
    return retained.expiresAtMs > Date.now() ? retained : undefined;
  }

  #reconcileLateResponse(
    retained: RetainedLateResponse,
    response: Record<string, unknown>,
  ): void {
    if (response.error !== undefined && response.error !== null) {
      const candidate = retained.candidate;
      if (candidate.method !== "thread/start") {
        const turnId = candidate.method === "turn/steer" || candidate.method === "turn/interrupt"
          ? candidate.requestedTurnId
          : undefined;
        this.runtime.recordLateMutationError({
          method: candidate.method,
          threadId: candidate.requestedThreadId,
          ...(turnId ? { turnId } : {}),
          timedOutAt: retained.timedOutAt,
          error: response.error,
        });
      }
      return;
    }
    const result = asRecord(response.result);
    if (!result) {
      return;
    }
    const candidate = retained.candidate;
    if (candidate.method === "thread/start" || candidate.method === "thread/resume") {
      const threadId = boundedScopeId(asRecord(result.thread)?.id);
      if (
        !threadId ||
        (candidate.method === "thread/resume" &&
          threadId !== candidate.requestedThreadId)
      ) {
        return;
      }
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId,
        timedOutAt: retained.timedOutAt,
      });
      return;
    }

    if (candidate.method === "turn/steer" || candidate.method === "turn/interrupt") {
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId: candidate.requestedThreadId,
        turnId: candidate.requestedTurnId,
        timedOutAt: retained.timedOutAt,
      });
      return;
    }

    const turn = asRecord(result.turn);
    const turnId = boundedScopeId(turn?.id);
    if (!turnId) {
      return;
    }
    const status = typeof turn?.status === "string" && turn.status.length > 0
      ? turn.status
      : undefined;
    this.runtime.reconcileLateMutationSuccess({
      method: candidate.method,
      threadId: candidate.requestedThreadId,
      turnId,
      ...(status ? { status } : {}),
      timedOutAt: retained.timedOutAt,
    });
  }

  async #write(message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    await this.#writeLine(encoded);
  }

  #onStdout(chunk: Buffer): void {
    if (this.#fatal || this.#closing) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.length > MAX_JSONL_BYTES) {
          this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        }
        return;
      }
      if (newline > MAX_JSONL_BYTES) {
        this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      try {
        this.#dispatch(JSON.parse(line.toString("utf8")) as unknown);
        if (this.#fatal) {
          return;
        }
      } catch (error) {
        this.#protocolFailure(`invalid app-server JSONL: ${messageFromUnknown(error)}`);
        return;
      }
    }
  }

  #dispatch(message: unknown): void {
    const record = asRecord(message);
    if (!record) {
      throw new Error("app-server emitted a non-object message");
    }
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "string" || typeof record.id === "number"
        ? record.id
        : undefined;

    if (method) {
      if (id !== undefined) {
        const recorded = this.runtime.recordServerRequest(id, method, record.params);
        if (recorded === "threadless") {
          void this.#write({
            id,
            error: THREADLESS_REQUEST_ERROR,
          }).catch((error: unknown) => {
            this.#protocolFailure(
              `failed to reject unsupported app-server request: ${messageFromUnknown(error)}`,
            );
          });
        } else if (recorded === "duplicate") {
          this.#protocolFailure(
            `app-server protocol anomaly: duplicate outstanding ${typeof id} request id`,
          );
        }
      } else {
        this.runtime.recordNotification(method, record.params);
      }
      return;
    }
    if (id === undefined) {
      throw new Error("app-server response has no request id");
    }
    const pending = this.#pendingCalls.get(rpcKey(id));
    if (!pending) {
      const retained = this.#takeLateResponse(rpcKey(id));
      if (retained) {
        this.#reconcileLateResponse(retained, record);
      }
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingCalls.delete(rpcKey(id));
    if ("error" in record && record.error !== undefined && record.error !== null) {
      const errorRecord = asRecord(record.error);
      const detail =
        typeof errorRecord?.message === "string"
          ? errorRecord.message
          : messageFromUnknown(record.error);
      pending.reject(
        new Error(`Codex app-server ${pending.method} failed: ${redactText(detail)}`),
      );
    } else {
      pending.resolve(record.result);
    }
  }

  #protocolFailure(message: string): void {
    if (this.#fatal) {
      return;
    }
    this.#fatal = new Error(redactText(message));
    this.runtime.markAppServerExited(this.#fatal.message);
    this.#rejectAll(this.#fatal);
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }, 500);
      timer.unref();
    }
  }

  #onChildError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.#child || this.#closing) {
      return;
    }
    this.#fatal = new Error(`Codex app-server process error: ${redactText(error.message)}`);
    this.runtime.markAppServerExited(this.#fatal.message);
    this.#rejectAll(this.#fatal);
  }

  #onStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.#child || this.#closing || this.#fatal) {
      return;
    }
    this.#protocolFailure(
      `Codex app-server stdin failed: ${messageFromUnknown(error)}`,
    );
  }

  #onStdinClose(child: ChildProcessWithoutNullStreams): void {
    if (
      child !== this.#child ||
      this.#closing ||
      this.#fatal ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    this.#protocolFailure("Codex app-server stdin closed unexpectedly");
  }

  #onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.#child) {
      return;
    }
    this.#initialized = false;
    if (this.#closing) {
      return;
    }
    const failure = new Error(
      `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    );
    this.#fatal = failure;
    this.runtime.markAppServerExited(failure.message);
    this.#rejectAll(failure);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingCalls.clear();
    this.#lateResponses.clear();
  }

  async #close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (!child) {
      return;
    }
    this.#rejectAll(new Error("Codex app-server manager is shutting down"));
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      if (!(await waitForExit(child, 1_500))) {
        child.kill();
        if (!(await waitForExit(child, 1_000))) {
          child.kill("SIGKILL");
          if (!(await waitForExit(child, 1_000))) {
            throw new Error("Codex app-server did not exit after SIGKILL");
          }
        }
      }
    }
    this.#child = null;
  }
}
