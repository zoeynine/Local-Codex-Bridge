import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { platformPolicyFor } from "./platform.js";
export const CHECKPOINT_DIRECTORY_ENV = "LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR";
export const LEGACY_CHECKPOINT_DIRECTORY_ENV = "LUMEN_CODEX_V2_CHECKPOINT_DIR";
export const CHECKPOINT_THREAD_ID_LIMIT = 200;
export const CHECKPOINT_TEXT_LIMIT = 4_000;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
function asRecord(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function boundedString(value, label, maximum = CHECKPOINT_TEXT_LIMIT) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    const normalized = value.trim();
    if (normalized.length > maximum) {
        throw new Error(`${label} exceeds ${maximum} characters`);
    }
    return normalized;
}
function nullableBoundedString(value, label) {
    return value === null ? null : boundedString(value, label);
}
function normalizeThreadId(value) {
    return boundedString(value, "thread_id", CHECKPOINT_THREAD_ID_LIMIT);
}
function parseOriginal(value) {
    const record = asRecord(value, "checkpoint original");
    return {
        original_goal: boundedString(record.original_goal, "checkpoint original_goal"),
        original_constraints: boundedString(record.original_constraints, "checkpoint original_constraints"),
        original_acceptance: boundedString(record.original_acceptance, "checkpoint original_acceptance"),
    };
}
function parseState(value, label) {
    const record = asRecord(value, label);
    return {
        effective_goal: boundedString(record.effective_goal, `${label}.effective_goal`),
        current_amendment: nullableBoundedString(record.current_amendment, `${label}.current_amendment`),
        current_understanding: boundedString(record.current_understanding, `${label}.current_understanding`),
        current_decision: boundedString(record.current_decision, `${label}.current_decision`),
        acceptance_status: boundedString(record.acceptance_status, `${label}.acceptance_status`),
        next_step: boundedString(record.next_step, `${label}.next_step`),
        captured_at: boundedString(record.captured_at, `${label}.captured_at`, 100),
    };
}
function parseDocument(value, expectedThreadId) {
    const record = asRecord(value, "checkpoint file");
    if (record.schema_version !== 1) {
        throw new Error("Unsupported checkpoint schema_version");
    }
    const threadId = normalizeThreadId(boundedString(record.thread_id, "checkpoint thread_id"));
    if (threadId !== expectedThreadId) {
        throw new Error("Checkpoint file thread_id does not match its storage key");
    }
    return {
        schema_version: 1,
        thread_id: threadId,
        original: parseOriginal(record.original),
        previous: record.previous === null ? null : parseState(record.previous, "checkpoint previous"),
        current: parseState(record.current, "checkpoint current"),
        created_at: boundedString(record.created_at, "checkpoint created_at", 100),
        updated_at: boundedString(record.updated_at, "checkpoint updated_at", 100),
    };
}
function sameSupervisorState(left, right) {
    return (left.effective_goal === right.effective_goal &&
        left.current_amendment === right.current_amendment &&
        left.current_understanding === right.current_understanding &&
        left.current_decision === right.current_decision &&
        left.acceptance_status === right.acceptance_status &&
        left.next_step === right.next_step);
}
function isMissingFile(error) {
    return (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT");
}
export function resolveCheckpointDirectory(environment = process.env, homeDirectory = homedir(), platformPolicy = platformPolicyFor()) {
    const configured = environment[CHECKPOINT_DIRECTORY_ENV]?.trim();
    if (configured) {
        return platformPolicy.normalizeExplicitCheckpointDirectory(configured);
    }
    const legacyConfigured = environment[LEGACY_CHECKPOINT_DIRECTORY_ENV]?.trim();
    if (legacyConfigured) {
        return platformPolicy.normalizeExplicitCheckpointDirectory(legacyConfigured);
    }
    return platformPolicy.resolveDefaultCheckpointDirectory(environment, homeDirectory);
}
export class CheckpointStore {
    directory;
    constructor(directory = resolveCheckpointDirectory()) {
        this.directory = directory;
        if (!isAbsolute(directory)) {
            throw new Error("Checkpoint directory must be an absolute path");
        }
    }
    read(rawThreadId) {
        const threadId = normalizeThreadId(rawThreadId);
        let descriptor;
        try {
            descriptor = openSync(this.#filePath(threadId), "r");
        }
        catch (error) {
            if (isMissingFile(error)) {
                return null;
            }
            throw error;
        }
        const payload = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES + 1);
        let length = 0;
        try {
            while (length < payload.byteLength) {
                const bytesRead = readSync(descriptor, payload, length, payload.byteLength - length, null);
                if (bytesRead === 0) {
                    break;
                }
                length += bytesRead;
            }
        }
        finally {
            closeSync(descriptor);
        }
        if (length > MAX_CHECKPOINT_BYTES) {
            throw new Error("Checkpoint file exceeds the bounded size limit");
        }
        let parsed;
        try {
            parsed = JSON.parse(payload.subarray(0, length).toString("utf8"));
        }
        catch {
            throw new Error("Checkpoint file is not valid JSON");
        }
        return parseDocument(parsed, threadId);
    }
    update(rawThreadId, input) {
        const threadId = normalizeThreadId(rawThreadId);
        const existing = this.read(threadId);
        const hasMutableInput = input.effective_goal !== undefined ||
            input.current_amendment !== undefined ||
            input.current_understanding !== undefined ||
            input.current_decision !== undefined ||
            input.acceptance_status !== undefined ||
            input.next_step !== undefined;
        if (existing === null) {
            const original = {
                original_goal: boundedString(input.original_goal, "original_goal"),
                original_constraints: boundedString(input.original_constraints, "original_constraints"),
                original_acceptance: boundedString(input.original_acceptance, "original_acceptance"),
            };
            const capturedAt = new Date().toISOString();
            const current = {
                effective_goal: input.effective_goal === undefined
                    ? original.original_goal
                    : boundedString(input.effective_goal, "effective_goal"),
                current_amendment: input.current_amendment === undefined
                    ? null
                    : nullableBoundedString(input.current_amendment, "current_amendment"),
                current_understanding: boundedString(input.current_understanding, "current_understanding"),
                current_decision: boundedString(input.current_decision, "current_decision"),
                acceptance_status: boundedString(input.acceptance_status, "acceptance_status"),
                next_step: boundedString(input.next_step, "next_step"),
                captured_at: capturedAt,
            };
            const checkpoint = {
                schema_version: 1,
                thread_id: threadId,
                original,
                previous: null,
                current,
                created_at: capturedAt,
                updated_at: capturedAt,
            };
            this.#write(checkpoint);
            return { operation: "initialized", checkpoint };
        }
        const immutableInputs = [
            ["original_goal", input.original_goal],
            ["original_constraints", input.original_constraints],
            ["original_acceptance", input.original_acceptance],
        ];
        for (const [field, supplied] of immutableInputs) {
            if (supplied !== undefined && boundedString(supplied, field) !== existing.original[field]) {
                throw new Error(`${field} is immutable after checkpoint initialization`);
            }
        }
        if (!hasMutableInput) {
            throw new Error("update requires at least one mutable supervisor-state field");
        }
        const capturedAt = new Date().toISOString();
        const current = {
            effective_goal: input.effective_goal === undefined
                ? existing.current.effective_goal
                : boundedString(input.effective_goal, "effective_goal"),
            current_amendment: input.current_amendment === undefined
                ? existing.current.current_amendment
                : nullableBoundedString(input.current_amendment, "current_amendment"),
            current_understanding: input.current_understanding === undefined
                ? existing.current.current_understanding
                : boundedString(input.current_understanding, "current_understanding"),
            current_decision: input.current_decision === undefined
                ? existing.current.current_decision
                : boundedString(input.current_decision, "current_decision"),
            acceptance_status: input.acceptance_status === undefined
                ? existing.current.acceptance_status
                : boundedString(input.acceptance_status, "acceptance_status"),
            next_step: input.next_step === undefined
                ? existing.current.next_step
                : boundedString(input.next_step, "next_step"),
            captured_at: capturedAt,
        };
        if (sameSupervisorState(existing.current, current)) {
            return { operation: "unchanged", checkpoint: existing };
        }
        const checkpoint = {
            ...existing,
            previous: existing.current,
            current,
            updated_at: capturedAt,
        };
        this.#write(checkpoint);
        return { operation: "updated", checkpoint };
    }
    #filePath(threadId) {
        const key = createHash("sha256").update(threadId, "utf8").digest("hex");
        return join(this.directory, `${key}.json`);
    }
    #write(checkpoint) {
        mkdirSync(this.directory, { recursive: true });
        const destination = this.#filePath(checkpoint.thread_id);
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        const payload = `${JSON.stringify(checkpoint)}\n`;
        if (Buffer.byteLength(payload, "utf8") > MAX_CHECKPOINT_BYTES) {
            throw new Error("Checkpoint content exceeds the bounded size limit");
        }
        try {
            writeFileSync(temporary, payload, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600,
            });
            renameSync(temporary, destination);
        }
        finally {
            rmSync(temporary, { force: true });
        }
    }
}
