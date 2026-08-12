import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CHECKPOINT_DIRECTORY_ENV = "LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR";
export const LEGACY_CHECKPOINT_DIRECTORY_ENV = "LUMEN_CODEX_V2_CHECKPOINT_DIR";
export const CHECKPOINT_THREAD_ID_LIMIT = 200;
export const CHECKPOINT_TEXT_LIMIT = 4_000;

const MAX_CHECKPOINT_BYTES = 256 * 1024;

export interface CheckpointOriginal {
  original_goal: string;
  original_constraints: string;
  original_acceptance: string;
}

export interface SupervisorState {
  effective_goal: string;
  current_amendment: string | null;
  current_understanding: string;
  current_decision: string;
  acceptance_status: string;
  next_step: string;
  captured_at: string;
}

export interface CheckpointDocument {
  schema_version: 1;
  thread_id: string;
  original: CheckpointOriginal;
  previous: SupervisorState | null;
  current: SupervisorState;
  created_at: string;
  updated_at: string;
}

export interface CheckpointUpdateInput {
  original_goal: string | undefined;
  original_constraints: string | undefined;
  original_acceptance: string | undefined;
  effective_goal: string | undefined;
  current_amendment: string | null | undefined;
  current_understanding: string | undefined;
  current_decision: string | undefined;
  acceptance_status: string | undefined;
  next_step: string | undefined;
}

export interface CheckpointUpdateResult {
  operation: "initialized" | "updated" | "unchanged";
  checkpoint: CheckpointDocument;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum = CHECKPOINT_TEXT_LIMIT): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters`);
  }
  return normalized;
}

function nullableBoundedString(value: unknown, label: string): string | null {
  return value === null ? null : boundedString(value, label);
}

function normalizeThreadId(value: string): string {
  return boundedString(value, "thread_id", CHECKPOINT_THREAD_ID_LIMIT);
}

function parseOriginal(value: unknown): CheckpointOriginal {
  const record = asRecord(value, "checkpoint original");
  return {
    original_goal: boundedString(record.original_goal, "checkpoint original_goal"),
    original_constraints: boundedString(
      record.original_constraints,
      "checkpoint original_constraints",
    ),
    original_acceptance: boundedString(
      record.original_acceptance,
      "checkpoint original_acceptance",
    ),
  };
}

function parseState(value: unknown, label: string): SupervisorState {
  const record = asRecord(value, label);
  return {
    effective_goal: boundedString(record.effective_goal, `${label}.effective_goal`),
    current_amendment: nullableBoundedString(
      record.current_amendment,
      `${label}.current_amendment`,
    ),
    current_understanding: boundedString(
      record.current_understanding,
      `${label}.current_understanding`,
    ),
    current_decision: boundedString(record.current_decision, `${label}.current_decision`),
    acceptance_status: boundedString(
      record.acceptance_status,
      `${label}.acceptance_status`,
    ),
    next_step: boundedString(record.next_step, `${label}.next_step`),
    captured_at: boundedString(record.captured_at, `${label}.captured_at`, 100),
  };
}

function parseDocument(value: unknown, expectedThreadId: string): CheckpointDocument {
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

function sameSupervisorState(left: SupervisorState, right: SupervisorState): boolean {
  return (
    left.effective_goal === right.effective_goal &&
    left.current_amendment === right.current_amendment &&
    left.current_understanding === right.current_understanding &&
    left.current_decision === right.current_decision &&
    left.acceptance_status === right.acceptance_status &&
    left.next_step === right.next_step
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveCheckpointDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configured = environment[CHECKPOINT_DIRECTORY_ENV]?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`${CHECKPOINT_DIRECTORY_ENV} must be an absolute path`);
    }
    return resolve(configured);
  }

  const legacyConfigured = environment[LEGACY_CHECKPOINT_DIRECTORY_ENV]?.trim();
  if (legacyConfigured) {
    if (!isAbsolute(legacyConfigured)) {
      throw new Error(`${LEGACY_CHECKPOINT_DIRECTORY_ENV} must be an absolute path`);
    }
    return resolve(legacyConfigured);
  }

  const base = join(homeDirectory, "Library", "Application Support");
  if (!isAbsolute(base)) {
    throw new Error("Unable to resolve an absolute macOS home directory for checkpoints");
  }
  return join(base, "LocalCodexBridge", "checkpoints");
}

export class CheckpointStore {
  constructor(readonly directory = resolveCheckpointDirectory()) {
    if (!isAbsolute(directory)) {
      throw new Error("Checkpoint directory must be an absolute path");
    }
  }

  read(rawThreadId: string): CheckpointDocument | null {
    const threadId = normalizeThreadId(rawThreadId);
    let descriptor: number;
    try {
      descriptor = openSync(this.#filePath(threadId), "r");
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
    const payload = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES + 1);
    let length = 0;
    try {
      while (length < payload.byteLength) {
        const bytesRead = readSync(
          descriptor,
          payload,
          length,
          payload.byteLength - length,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
    } finally {
      closeSync(descriptor);
    }
    if (length > MAX_CHECKPOINT_BYTES) {
      throw new Error("Checkpoint file exceeds the bounded size limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.subarray(0, length).toString("utf8")) as unknown;
    } catch {
      throw new Error("Checkpoint file is not valid JSON");
    }
    return parseDocument(parsed, threadId);
  }

  update(rawThreadId: string, input: CheckpointUpdateInput): CheckpointUpdateResult {
    const threadId = normalizeThreadId(rawThreadId);
    const existing = this.read(threadId);
    const hasMutableInput =
      input.effective_goal !== undefined ||
      input.current_amendment !== undefined ||
      input.current_understanding !== undefined ||
      input.current_decision !== undefined ||
      input.acceptance_status !== undefined ||
      input.next_step !== undefined;

    if (existing === null) {
      const original: CheckpointOriginal = {
        original_goal: boundedString(input.original_goal, "original_goal"),
        original_constraints: boundedString(input.original_constraints, "original_constraints"),
        original_acceptance: boundedString(input.original_acceptance, "original_acceptance"),
      };
      const capturedAt = new Date().toISOString();
      const current: SupervisorState = {
        effective_goal:
          input.effective_goal === undefined
            ? original.original_goal
            : boundedString(input.effective_goal, "effective_goal"),
        current_amendment:
          input.current_amendment === undefined
            ? null
            : nullableBoundedString(input.current_amendment, "current_amendment"),
        current_understanding: boundedString(
          input.current_understanding,
          "current_understanding",
        ),
        current_decision: boundedString(input.current_decision, "current_decision"),
        acceptance_status: boundedString(input.acceptance_status, "acceptance_status"),
        next_step: boundedString(input.next_step, "next_step"),
        captured_at: capturedAt,
      };
      const checkpoint: CheckpointDocument = {
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

    const immutableInputs: ReadonlyArray<[
      keyof CheckpointOriginal,
      string | undefined,
    ]> = [
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
    const current: SupervisorState = {
      effective_goal:
        input.effective_goal === undefined
          ? existing.current.effective_goal
          : boundedString(input.effective_goal, "effective_goal"),
      current_amendment:
        input.current_amendment === undefined
          ? existing.current.current_amendment
          : nullableBoundedString(input.current_amendment, "current_amendment"),
      current_understanding:
        input.current_understanding === undefined
          ? existing.current.current_understanding
          : boundedString(input.current_understanding, "current_understanding"),
      current_decision:
        input.current_decision === undefined
          ? existing.current.current_decision
          : boundedString(input.current_decision, "current_decision"),
      acceptance_status:
        input.acceptance_status === undefined
          ? existing.current.acceptance_status
          : boundedString(input.acceptance_status, "acceptance_status"),
      next_step:
        input.next_step === undefined
          ? existing.current.next_step
          : boundedString(input.next_step, "next_step"),
      captured_at: capturedAt,
    };
    if (sameSupervisorState(existing.current, current)) {
      return { operation: "unchanged", checkpoint: existing };
    }

    const checkpoint: CheckpointDocument = {
      ...existing,
      previous: existing.current,
      current,
      updated_at: capturedAt,
    };
    this.#write(checkpoint);
    return { operation: "updated", checkpoint };
  }

  #filePath(threadId: string): string {
    const key = createHash("sha256").update(threadId, "utf8").digest("hex");
    return join(this.directory, `${key}.json`);
  }

  #write(checkpoint: CheckpointDocument): void {
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
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
