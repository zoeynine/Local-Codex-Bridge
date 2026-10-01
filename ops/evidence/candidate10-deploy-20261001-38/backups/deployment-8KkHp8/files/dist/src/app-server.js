import { spawn, spawnSync } from "node:child_process";
import { RuntimeStore, redactText, sanitizeForTransport, } from "./runtime.js";
import { platformPolicyFor } from "./platform.js";
import { VERSION } from "./version.js";
const MAX_JSONL_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LATE_RESPONSE_TTL_MS = 60_000;
const DEFAULT_LATE_RESPONSE_LIMIT = 256;
const GRACEFUL_CLOSE_TIMEOUT_MS = 1_500;
const SOFT_TERMINATE_TIMEOUT_MS = 1_000;
const HARD_TERMINATE_TIMEOUT_MS = 1_000;
const MAX_SCOPE_ID_CHARS = 200;
const THREADLESS_REQUEST_ERROR = {
    code: -32601,
    message: "Unsupported app-server request without thread context",
};
const MUTATING_REQUEST_METHODS = new Set([
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
]);
const RECOVERY_READ_METHODS = new Set(["model/list", "thread/list", "thread/read", "thread/items/list"]);
const DEFAULT_CHILD_TERMINATION_TIMEOUTS = {
    gracefulMs: GRACEFUL_CLOSE_TIMEOUT_MS,
    softMs: SOFT_TERMINATE_TIMEOUT_MS,
    hardMs: HARD_TERMINATE_TIMEOUT_MS,
};
function rpcKey(id) {
    return `${typeof id}:${String(id)}`;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function boundedScopeId(value) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_SCOPE_ID_CHARS
        ? value
        : undefined;
}
function positiveIntegerOption(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return resolved;
}
function lateResponseCandidate(method, params) {
    if (method === "thread/start") {
        return { method };
    }
    const record = asRecord(params);
    if (method === "turn/steer" || method === "turn/interrupt") {
        const requestedThreadId = boundedScopeId(record?.threadId);
        const requestedTurnId = boundedScopeId(method === "turn/steer" ? record?.expectedTurnId : record?.turnId);
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
function messageFromUnknown(value) {
    if (value instanceof Error) {
        return value.message;
    }
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(sanitizeForTransport(value));
    }
    catch {
        return String(value);
    }
}
function requestTimeoutError(method) {
    if (MUTATING_REQUEST_METHODS.has(method)) {
        return new Error(`Codex app-server acknowledgement timed out for already-sent mutating request ${method}; operation outcome is UNKNOWN because Codex may already have accepted it. Re-observe or read before retrying. No automatic retry is performed.`);
    }
    return new Error(`Codex app-server request timed out: ${method}`);
}
export function resolveCodexExecutable(environment = process.env) {
    const explicit = environment.CODEX_EXE?.trim() || environment.CODEX_DESKTOP_EXE?.trim();
    if (explicit) {
        if (/[\0\r\n]/.test(explicit)) {
            throw new Error("Codex executable selection contains an invalid control character");
        }
        return explicit;
    }
    return "codex";
}
export function resolveCodexChildEnvironment(environment = process.env) {
    const childEnvironment = { ...environment };
    delete childEnvironment.CONTROL_PLANE_API_KEY;
    return childEnvironment;
}
export function diagnoseCodexVersion(selected, creator) {
    const parse = (value) => value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/)?.slice(1).map(Number);
    const reader = parse(selected);
    const writer = parse(creator);
    if (!reader || !writer)
        return "version_unknown";
    for (let index = 0; index < 3; index++) {
        if (reader[index] < writer[index])
            return "reader_older_than_thread_creator";
        if (reader[index] > writer[index])
            break;
    }
    return "reader_not_older_compatibility_unverified";
}
async function waitForExit(child, timeoutMs, platformPolicy) {
    if (platformPolicy.hasChildExited(child)) {
        return true;
    }
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            child.off("exit", onExit);
            resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
    });
}
export async function terminateAppServerChild(child, platformPolicy, timeouts = DEFAULT_CHILD_TERMINATION_TIMEOUTS) {
    if (platformPolicy.hasChildExited(child)) {
        return;
    }
    let terminationError;
    try {
        child.stdin.end();
    }
    catch (error) {
        terminationError = error instanceof Error ? error : new Error(String(error));
    }
    if (await waitForExit(child, timeouts.gracefulMs, platformPolicy)) {
        return;
    }
    if (platformPolicy.hasChildExited(child)) {
        return;
    }
    try {
        platformPolicy.softTerminateChild(child);
    }
    catch (error) {
        terminationError = error instanceof Error ? error : new Error(String(error));
    }
    if (await waitForExit(child, timeouts.softMs, platformPolicy)) {
        return;
    }
    if (platformPolicy.hasChildExited(child)) {
        return;
    }
    try {
        platformPolicy.hardTerminateChild(child);
    }
    catch (error) {
        terminationError = error instanceof Error ? error : new Error(String(error));
    }
    if (await waitForExit(child, timeouts.hardMs, platformPolicy)) {
        return;
    }
    const detail = terminationError ? `: ${terminationError.message}` : "";
    throw new Error(`Codex app-server did not exit after graceful, soft, and hard termination${detail}`);
}
export function writeWithBackpressure(stream, chunk) {
    if (!stream.writable || stream.writableEnded || stream.destroyed) {
        return Promise.reject(new Error("Codex app-server stdin is not writable"));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let writeReturned = false;
        let callbackDone = false;
        let drainDone = false;
        const cleanup = () => {
            stream.off("drain", onDrain);
            stream.off("error", onError);
            stream.off("close", onClose);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const maybeResolve = () => {
            if (!settled && writeReturned && callbackDone && drainDone) {
                settled = true;
                cleanup();
                resolve();
            }
        };
        const onDrain = () => {
            drainDone = true;
            maybeResolve();
        };
        const onError = (error) => fail(error);
        const onClose = () => fail(new Error("Codex app-server stdin closed during write"));
        const onWrite = (error) => {
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
        }
        catch (error) {
            fail(error instanceof Error
                ? error
                : new Error(messageFromUnknown(error)));
        }
    });
}
export function createSerializedWriter(write) {
    let tail = Promise.resolve();
    return async (chunk) => {
        const current = tail.then(() => write(chunk));
        tail = current.catch(() => undefined);
        await current;
    };
}
export class AppServerManager {
    runtime;
    #executable;
    #prefixArgs;
    #environment;
    #platformPolicy;
    #requestTimeoutMs;
    #lateResponseTtlMs;
    #lateResponseLimit;
    #pendingCalls = new Map();
    #lateResponses = new Map();
    #writeLine;
    #child = null;
    #childTerminationPromise = null;
    #startPromise = null;
    #closePromise = null;
    #fatal = null;
    #closing = false;
    #initialized = false;
    #nextRequestId = 1;
    #stdoutBuffer = Buffer.alloc(0);
    #cliVersion = null;
    #overflowFailure = false;
    #recoveryUsed = false;
    #recoveryPromise = null;
    get transportDiagnostics() {
        return { buffered_bytes: this.#stdoutBuffer.length, recovery_used: this.#recoveryUsed, fatal_reason: this.#fatal?.message ?? null };
    }
    get binaryDiagnostics() {
        return { executable: redactText(this.#executable), cli_version: this.#cliVersion };
    }
    constructor(runtime = new RuntimeStore(), options = {}) {
        this.runtime = runtime;
        const sourceEnvironment = options.environment ?? process.env;
        this.#platformPolicy = options.platformPolicy ?? platformPolicyFor();
        this.#executable = options.executable ?? resolveCodexExecutable(sourceEnvironment);
        this.#prefixArgs = options.prefixArgs ?? [];
        this.#environment = resolveCodexChildEnvironment(sourceEnvironment);
        this.#requestTimeoutMs =
            options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.#lateResponseTtlMs = positiveIntegerOption(options.lateResponseTtlMs, DEFAULT_LATE_RESPONSE_TTL_MS, "lateResponseTtlMs");
        this.#lateResponseLimit = positiveIntegerOption(options.lateResponseLimit, DEFAULT_LATE_RESPONSE_LIMIT, "lateResponseLimit");
        this.#writeLine = createSerializedWriter(async (chunk) => {
            const child = this.#child;
            if (this.#closing ||
                this.#fatal ||
                !child ||
                child.exitCode !== null ||
                child.signalCode !== null) {
                throw new Error("Codex app-server stdin is not writable");
            }
            await writeWithBackpressure(child.stdin, chunk);
        });
    }
    async request(method, params) {
        if (method === "thread/read" && asRecord(params)?.includeTurns === true) {
            throw new Error("Unbounded thread/read includeTurns is disabled; use metadata and bounded thread/items/list instead");
        }
        const safeRead = RECOVERY_READ_METHODS.has(method);
        if (this.#recoveryPromise) {
            if (!safeRead)
                throw new Error("Codex app-server is unavailable while read-only recovery is in progress; no mutation was sent");
            await this.#recoveryPromise;
        }
        else if (this.#fatal && this.#overflowFailure && !this.#recoveryUsed && safeRead && !this.#closing) {
            this.#recoveryUsed = true;
            this.#recoveryPromise = this.#recoverAfterOverflow();
            try {
                await this.#recoveryPromise;
            }
            finally {
                this.#recoveryPromise = null;
            }
        }
        await this.ensureReady();
        return await this.#request(method, params, this.#requestTimeoutMs);
    }
    async #recoverAfterOverflow() {
        // One attempt per manager lifetime, initiated by a NEW safe read. No failed call is replayed.
        const child = this.#child;
        if (child)
            await this.#terminateChild(child);
        if (this.#startPromise)
            await this.#startPromise.catch(() => undefined);
        if (this.#closing)
            throw new Error("Codex app-server manager is closing");
        this.#child = null;
        this.#childTerminationPromise = null;
        this.#startPromise = null;
        this.#initialized = false;
        this.#stdoutBuffer = Buffer.alloc(0);
        this.#fatal = null;
        this.#overflowFailure = false;
        await this.ensureReady();
    }
    async respond(id, result) {
        if (this.#recoveryPromise)
            throw new Error("Codex app-server is unavailable during recovery; response not sent");
        await this.ensureReady();
        await this.#write({ id, result });
    }
    async ensureReady() {
        if (this.#closing) {
            throw new Error("Codex app-server manager is closing");
        }
        if (this.#fatal) {
            throw new Error(`Codex app-server is unavailable and will not be auto-restarted: ${this.#fatal.message}`);
        }
        if (this.#initialized && this.#child) {
            return;
        }
        if (!this.#startPromise) {
            this.#startPromise = this.#start();
        }
        await this.#startPromise;
    }
    async close() {
        if (this.#closePromise) {
            return await this.#closePromise;
        }
        this.#closePromise = this.#close();
        return await this.#closePromise;
    }
    async #start() {
        if (this.#prefixArgs.length === 0) {
            const probe = spawnSync(this.#executable, ["--version"], {
                env: this.#environment, encoding: "utf8", timeout: 3000, maxBuffer: 4096,
                ...this.#platformPolicy.appServerSpawnOptions(),
            });
            this.#cliVersion = probe.status === 0
                ? probe.stdout?.match(/codex-cli\s+(\S+)/)?.[1] ?? null
                : null;
        }
        let child;
        try {
            child = spawn(this.#executable, [...this.#prefixArgs, "app-server", "--listen", "stdio://"], {
                stdio: ["pipe", "pipe", "pipe"],
                ...this.#platformPolicy.appServerSpawnOptions(),
                env: this.#environment,
            });
        }
        catch (error) {
            this.#fatal = new Error(`Failed to spawn ${this.#executable}: ${redactText(messageFromUnknown(error))}`);
            throw this.#fatal;
        }
        this.#child = child;
        child.stdin.on("error", (error) => this.#onStdinError(child, error));
        child.stdin.once("close", () => this.#onStdinClose(child));
        child.stdout.on("data", (chunk) => { if (child === this.#child)
            this.#onStdout(chunk); });
        child.stderr.on("data", () => {
            // Drain without forwarding potentially sensitive child diagnostics.
        });
        child.once("exit", (code, signal) => this.#onExit(child, code, signal));
        try {
            await new Promise((resolve, reject) => {
                const onSpawn = () => {
                    child.off("error", onError);
                    resolve();
                };
                const onError = (error) => {
                    child.off("spawn", onSpawn);
                    reject(error);
                };
                child.once("spawn", onSpawn);
                child.once("error", onError);
            });
            child.on("error", (error) => this.#onChildError(child, error));
            await this.#request("initialize", {
                clientInfo: {
                    name: "local-codex-bridge",
                    title: "Local Codex Bridge",
                    version: VERSION,
                },
                capabilities: {
                    experimentalApi: true,
                    requestAttestation: false,
                    mcpServerOpenaiFormElicitation: false,
                    optOutNotificationMethods: [],
                },
            }, 30_000);
            await this.#write({ method: "initialized", params: {} });
            this.#initialized = true;
        }
        catch (error) {
            const failure = this.#fatal ??
                new Error(`Codex app-server initialization failed: ${redactText(messageFromUnknown(error))}`);
            this.#fatal = failure;
            try {
                await this.#terminateChild(child);
            }
            catch (terminationError) {
                failure.message += `; shutdown failed: ${messageFromUnknown(terminationError)}`;
            }
            throw failure;
        }
    }
    #request(method, params, timeoutMs) {
        const id = this.#nextRequestId;
        this.#nextRequestId += 1;
        const key = rpcKey(id);
        const lateCandidate = lateResponseCandidate(method, params);
        return new Promise((resolve, reject) => {
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
            void this.#write({ method, id, params }).catch((error) => {
                const pending = this.#pendingCalls.get(key);
                if (!pending) {
                    this.#lateResponses.delete(key);
                    return;
                }
                clearTimeout(pending.timer);
                this.#pendingCalls.delete(key);
                pending.reject(new Error(`Failed to write app-server request ${method}: ${messageFromUnknown(error)}`));
            });
        });
    }
    #retainLateResponse(key, candidate) {
        const now = Date.now();
        for (const [retainedKey, retained] of this.#lateResponses) {
            if (retained.expiresAtMs <= now) {
                this.#lateResponses.delete(retainedKey);
            }
        }
        while (this.#lateResponses.size >= this.#lateResponseLimit) {
            const oldest = this.#lateResponses.keys().next().value;
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
    #takeLateResponse(key) {
        const retained = this.#lateResponses.get(key);
        if (!retained) {
            return undefined;
        }
        this.#lateResponses.delete(key);
        return retained.expiresAtMs > Date.now() ? retained : undefined;
    }
    #reconcileLateResponse(retained, response) {
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
            if (!threadId ||
                (candidate.method === "thread/resume" &&
                    threadId !== candidate.requestedThreadId)) {
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
    async #write(message) {
        const encoded = `${JSON.stringify(message)}\n`;
        await this.#writeLine(encoded);
    }
    #onStdout(chunk) {
        if (this.#fatal || this.#closing) {
            return;
        }
        this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
        while (true) {
            const newline = this.#stdoutBuffer.indexOf(0x0a);
            if (newline < 0) {
                if (this.#stdoutBuffer.length > MAX_JSONL_BYTES) {
                    this.#lineOverflow(this.#stdoutBuffer.length);
                }
                return;
            }
            if (newline > MAX_JSONL_BYTES) {
                this.#lineOverflow(newline);
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
                this.#dispatch(JSON.parse(line.toString("utf8")));
                if (this.#fatal) {
                    return;
                }
            }
            catch (error) {
                this.#protocolFailure(`invalid app-server JSONL: ${messageFromUnknown(error)}`);
                return;
            }
        }
    }
    #dispatch(message) {
        const record = asRecord(message);
        if (!record) {
            throw new Error("app-server emitted a non-object message");
        }
        const method = typeof record.method === "string" ? record.method : undefined;
        const id = typeof record.id === "string" || typeof record.id === "number"
            ? record.id
            : undefined;
        if (method) {
            if (id !== undefined) {
                const recorded = this.runtime.recordServerRequest(id, method, record.params);
                if (recorded === "threadless") {
                    void this.#write({
                        id,
                        error: THREADLESS_REQUEST_ERROR,
                    }).catch((error) => {
                        this.#protocolFailure(`failed to reject unsupported app-server request: ${messageFromUnknown(error)}`);
                    });
                }
                else if (recorded === "duplicate") {
                    this.#protocolFailure(`app-server protocol anomaly: duplicate outstanding ${typeof id} request id`);
                }
            }
            else {
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
            const detail = typeof errorRecord?.message === "string"
                ? errorRecord.message
                : messageFromUnknown(record.error);
            pending.reject(new Error(`Codex app-server ${pending.method} failed: ${redactText(detail)}; selected executable=${redactText(this.#executable)}; CLI version=${this.#cliVersion ?? "unknown"}`));
        }
        else {
            pending.resolve(record.result);
        }
    }
    #protocolFailure(message) {
        if (this.#fatal) {
            return;
        }
        this.#fatal = new Error(redactText(message));
        this.#stdoutBuffer = Buffer.alloc(0);
        this.runtime.markAppServerExited(this.#fatal.message);
        this.#rejectAll(this.#fatal);
        const child = this.#child;
        if (child && !this.#platformPolicy.hasChildExited(child)) {
            void this.#terminateChild(child).catch(() => {
                // The latched protocol failure remains authoritative; close() reuses and awaits this same bounded termination attempt.
            });
        }
    }
    #lineOverflow(observedBytes) {
        // Known pending-call metadata only; never parse or stringify the oversized line.
        const pending = Array.from(this.#pendingCalls.entries()).slice(0, 8)
            .map(([id, call]) => ({ id, method: call.method.slice(0, 100) }));
        this.#overflowFailure = true;
        this.#protocolFailure(`app-server JSONL line exceeded 10 MiB; limit_bytes=${MAX_JSONL_BYTES}; observed_at_least_bytes=${observedBytes}; pending_requests=${JSON.stringify(pending)}`);
    }
    #onChildError(child, error) {
        if (child !== this.#child || this.#closing || this.#fatal) {
            return;
        }
        this.#fatal = new Error(`Codex app-server process error: ${redactText(error.message)}`);
        this.runtime.markAppServerExited(this.#fatal.message);
        this.#rejectAll(this.#fatal);
    }
    #onStdinError(child, error) {
        if (child !== this.#child || this.#closing || this.#fatal) {
            return;
        }
        this.#protocolFailure(`Codex app-server stdin failed: ${messageFromUnknown(error)}`);
    }
    #onStdinClose(child) {
        if (child !== this.#child ||
            this.#closing ||
            this.#fatal ||
            child.exitCode !== null ||
            child.signalCode !== null) {
            return;
        }
        this.#protocolFailure("Codex app-server stdin closed unexpectedly");
    }
    #onExit(child, code, signal) {
        if (child !== this.#child) {
            return;
        }
        this.#initialized = false;
        if (this.#closing || this.#fatal) {
            return;
        }
        const failure = new Error(`Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
        this.#fatal = failure;
        this.runtime.markAppServerExited(failure.message);
        this.#rejectAll(failure);
    }
    #rejectAll(error) {
        for (const pending of this.#pendingCalls.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pendingCalls.clear();
        this.#lateResponses.clear();
    }
    #terminateChild(child) {
        if (!this.#childTerminationPromise) {
            this.#childTerminationPromise = terminateAppServerChild(child, this.#platformPolicy);
        }
        return this.#childTerminationPromise;
    }
    async #close() {
        this.#closing = true;
        const child = this.#child;
        if (!child) {
            return;
        }
        this.#rejectAll(new Error("Codex app-server manager is shutting down"));
        await this.#terminateChild(child);
        this.#child = null;
    }
}
