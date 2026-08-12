import path from "node:path";

import { AppServerManager } from "./app-server.js";
import {
  CHECKPOINT_TEXT_LIMIT,
  CHECKPOINT_THREAD_ID_LIMIT,
  CheckpointStore,
} from "./checkpoint.js";
import {
  MAX_OBSERVE_WAIT_MS,
  sanitizeForTransport,
  type RpcId,
} from "./runtime.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const approvalPolicySchema = {
  type: "string",
  enum: ["untrusted", "on-request", "never"],
  description: "Codex app-server approval policy override.",
};

const sandboxSchema = {
  type: "string",
  enum: ["read-only", "workspace-write", "danger-full-access"],
  description: "Codex app-server sandbox mode override.",
};

const NATIVE_SANDBOX_POLICY_TYPE_BY_MODE = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
} as const;

type PublicSandboxMode = keyof typeof NATIVE_SANDBOX_POLICY_TYPE_BY_MODE;

const SUPPORTED_RESPOND_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
]);

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "codex_threads",
    title: "Codex Threads",
    description:
      "List or search persistent local Codex threads through thread/list, or read one thread through thread/read. This does not reconstruct live Bridge events.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "When supplied, read this exact Codex thread instead of listing threads.",
        },
        include_turns: {
          type: "boolean",
          default: false,
          description: "Include persisted turns when reading one thread.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Optional exact absolute POSIX cwd filter for thread/list on macOS.",
        },
        search_term: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional Codex title substring filter for thread/list.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior thread/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum threads in the returned page.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Threads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start a persistent Codex thread and turn, or resume an existing thread and start a turn. Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed; thread_id is not a permanent task identity. Returns as soon as turn/start is accepted; observe separately for events and completion.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 200000,
          description: "User text passed directly to Codex as one text input item.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Existing persistent Codex thread to resume. Omit to create a new thread.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Absolute POSIX cwd on macOS. Required for a new thread; optional override for resume.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional model identifier passed through to app-server.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "Optional reasoning effort passed through to turn/start.",
        },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
      },
      required: ["text"],
      anyOf: [{ required: ["thread_id"] }, { required: ["cwd"] }],
      additionalProperties: false,
    },
    annotations: {
      title: "Start or Continue Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_observe",
    title: "Observe Codex Turn",
    description:
      "Read bounded incremental sanitized Bridge runtime events, pending requests, and terminal output for a thread. Optional wait_ms performs one bounded event-driven wait only when the live turn is active and the current snapshot has nothing useful; it is not polling or stall detection. After Bridge process loss, falls back to persistent thread/read history and marks live state unreconstructable. A long interval with no new command or output can still mean Codex is actively reasoning; absence of new command activity alone is not evidence of a stall. When actively supervising an in-progress turn, use repeated bounded-wait observe calls until terminal unless the user explicitly pauses or stops; do not end supervision merely because one snapshot is inProgress. After every wake or deadline return, inspect the newly available events/state and decide whether steer, respond, or interruption is needed before starting the next bounded wait.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Codex thread to observe." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Return runtime events with a cursor greater than this value.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Maximum runtime events to return.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OBSERVE_WAIT_MS,
          default: 0,
          description:
            "Optional per-call wait for the next live runtime change when nothing useful is ready; 0 returns immediately. This is event-driven waiting, not stall detection.",
        },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Observe Codex Turn",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_steer",
    title: "Steer Active Codex Turn",
    description:
      "Append text to the same active Codex turn using turn/steer with an expected turn-id precondition. This does not create a new turn. Do not steer merely because reasoning is taking a long time or no new command has appeared; steer only for a semantic redirect or correction based on new evidence or changed user intent.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        expected_turn_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Exact active turn id required by app-server.",
        },
        text: { type: "string", minLength: 1, maxLength: 200000, description: "Additional user text." },
      },
      required: ["thread_id", "expected_turn_id", "text"],
      additionalProperties: false,
    },
    annotations: {
      title: "Steer Active Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_respond",
    title: "Respond to Codex Request",
    description:
      "Answer one currently pending app-server server request by its original raw JSON-RPC id and exact thread/method scope. Supports the approval and item/tool/requestUserInput response contracts implemented by this facade. Unsupported or unknown methods fail locally and remain pending; do not guess a future response contract.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, maxLength: 300, description: "Exact app-server request method." },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"],
          description: "Command or file approval decision.",
        },
        execpolicy_amendment: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Command approval exec-policy amendment; encoded in app-server's native decision shape.",
        },
        answers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              answers: { type: "array", items: { type: "string" } },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          description: "request_user_input question-id to answer-array mapping.",
        },
        response: {
          type: "object",
          additionalProperties: true,
          description: "Exact generic result object for item/tool/requestUserInput; unsupported or future methods remain pending and are rejected locally.",
        },
      },
      required: ["request_id", "thread_id", "method"],
      anyOf: [
        { required: ["decision"] },
        { required: ["execpolicy_amendment"] },
        { required: ["answers"] },
        { required: ["response"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Respond to Codex Request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_interrupt",
    title: "Interrupt Codex Turn",
    description:
      "Directly request turn/interrupt for the specified active Codex thread and turn. It does not stop or restart the Bridge or Codex app-server processes.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex turn to interrupt." },
      },
      required: ["thread_id", "turn_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Interrupt Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_checkpoint",
    title: "Checkpoint Codex Supervision",
    description:
      "Optional, bounded supervisor cognition memory keyed to one native Codex thread_id; the key is not a permanent task identity and does not require future work to remain on that thread. Use it to protect the original goal, constraints, and acceptance plus concise supervisor state during long or complex supervision when context dilution or goal drift makes an external anchor worthwhile. Initialization is not tied to crossing a ChatGPT window or round, starting another Codex turn, or switching native threads; initialize early when a task is already expected to be sufficiently long or complex for that protection. Do not use for one-shot work, and do not turn duration into a hard threshold: elapsed time, observe/poll count, token count, or mere silence are not automatic triggers. Later updates remain semantic-event driven and require a material change in understanding or root cause, constraint or scope interpretation, steering decision, user-authorized amendment or effective goal, or acceptance judgment or an explicit decision not to accept yet. Before final acceptance of a checkpointed task, read it once to re-anchor the original goal, constraints, acceptance, and current supervisor frame. This tool is optional and uncoupled from all other tools. Store concise supervisor summaries only; never prompts, transcripts, raw events, command output, final answers, or raw event streams. Updates preserve only immutable original plus bounded previous/current supervisor state.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update"],
          description:
            "Read the checkpoint, or initialize/update it at a material supervisor decision point.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_THREAD_ID_LIMIT,
          description: "Native Codex thread id; no second task identifier is created.",
        },
        original_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original user goal. Required only on initialization and immutable thereafter.",
        },
        original_constraints: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original constraints. Required only on initialization and immutable thereafter.",
        },
        original_acceptance: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original acceptance criteria. Required only on initialization and immutable thereafter.",
        },
        effective_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Current effective goal after legitimate user amendments; defaults to original_goal on initialization.",
        },
        current_amendment: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: CHECKPOINT_TEXT_LIMIT },
            { type: "null" },
          ],
          description:
            "Latest concise user-authorized requirement amendment, or null to clear it, without changing the immutable original.",
        },
        current_understanding: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current concise root-cause or task understanding.",
        },
        current_decision: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current supervisor decision and why it matters.",
        },
        acceptance_status: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise acceptance assessment, not a task lifecycle or job status.",
        },
        next_step: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Single next supervision step.",
        },
      },
      required: ["action", "thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Checkpoint Codex Supervision",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function asObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`Unknown argument field: ${extras[0]}`);
  }
}

function requiredString(args: Record<string, unknown>, key: string, max = 200_000): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${key} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max = 200_000,
): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return requiredString(args, key, max);
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function enumValue<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

export function validateCwd(value: string): string {
  if (value.includes("\0")) {
    throw new Error("cwd contains a NUL character");
  }
  if (!path.posix.isAbsolute(value)) {
    throw new Error("cwd must be an absolute POSIX path on macOS");
  }
  return path.posix.normalize(value);
}

function responseRecord(value: unknown, method: string): Record<string, unknown> {
  const record = asObject(value, `${method} response`);
  return record;
}

function extractThreadId(result: unknown, method: string): string {
  const thread = asObject(asObject(result, `${method} result`).thread, `${method} result.thread`);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error(`${method} returned no thread id`);
  }
  return thread.id;
}

function extractTurnId(result: unknown, method: string): string {
  const turn = asObject(asObject(result, `${method} result`).turn, `${method} result.turn`);
  if (typeof turn.id !== "string" || turn.id.length === 0) {
    throw new Error(`${method} returned no turn id`);
  }
  return turn.id;
}

function extractSandboxPolicy(
  result: unknown,
  method: string,
  requestedSandbox: PublicSandboxMode,
): Record<string, unknown> {
  const policy = asObject(
    asObject(result, `${method} result`).sandbox,
    `${method} result.sandbox`,
  );
  const expectedType = NATIVE_SANDBOX_POLICY_TYPE_BY_MODE[requestedSandbox];
  if (policy.type !== expectedType) {
    throw new Error(
      `${method} returned sandbox policy type ${String(policy.type)} for requested ${requestedSandbox}`,
    );
  }
  return policy;
}

function storedTerminal(threadResult: unknown): unknown {
  const result = asObject(threadResult, "thread/read result");
  const thread = asObject(result.thread, "thread/read result.thread");
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns.length > 0 ? asObject(turns.at(-1), "stored turn") : null;
  if (!turn || typeof turn.id !== "string") {
    return null;
  }
  const status = typeof turn.status === "string" ? turn.status : "unknown";
  if (!["completed", "failed", "interrupted"].includes(status)) {
    return null;
  }
  const items = Array.isArray(turn.items) ? turn.items : [];
  let finalResult: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agentMessage" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      finalResult = (item as Record<string, unknown>).text as string;
      break;
    }
  }
  return sanitizeForTransport({
    turn_id: turn.id,
    status,
    completed_at: null,
    final_result: finalResult,
    error: turn.error ?? null,
    source: "codex_app_server_thread_read",
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MCP request cancelled");
  }
}

export class ControlSurface {
  private checkpoints: CheckpointStore | undefined;

  constructor(
    private readonly appServer: AppServerManager,
    checkpoints?: CheckpointStore,
  ) {
    this.checkpoints = checkpoints;
  }

  async call(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = asObject(rawArguments ?? {});
    switch (name) {
      case "codex_threads":
        return await this.#threads(args);
      case "codex_turn":
        return await this.#turn(args);
      case "codex_observe":
        return await this.#observe(args, signal);
      case "codex_steer":
        return await this.#steer(args);
      case "codex_respond":
        return await this.#respond(args);
      case "codex_interrupt":
        return await this.#interrupt(args);
      case "codex_checkpoint":
        return this.#checkpoint(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  #checkpoint(args: Record<string, unknown>): unknown {
    const fields = [
      "action",
      "thread_id",
      "original_goal",
      "original_constraints",
      "original_acceptance",
      "effective_goal",
      "current_amendment",
      "current_understanding",
      "current_decision",
      "acceptance_status",
      "next_step",
    ] as const;
    onlyKeys(args, fields);
    const action = enumValue(args, "action", ["read", "update"] as const);
    if (!action) {
      throw new Error("action is required");
    }
    const threadId = requiredString(args, "thread_id", CHECKPOINT_THREAD_ID_LIMIT).trim();
    if (action === "read") {
      onlyKeys(args, ["action", "thread_id"]);
      const checkpoint = this.#checkpointStore().read(threadId);
      return checkpoint === null
        ? {
            source: "local_codex_bridge_checkpoint",
            found: false,
            thread_id: threadId,
            checkpoint: null,
          }
        : {
            source: "local_codex_bridge_checkpoint",
            found: true,
            operation: "read",
            checkpoint,
          };
    }

    let currentAmendment: string | null | undefined;
    if (args.current_amendment === null) {
      currentAmendment = null;
    } else {
      currentAmendment = optionalString(
        args,
        "current_amendment",
        CHECKPOINT_TEXT_LIMIT,
      );
    }
    const result = this.#checkpointStore().update(threadId, {
      original_goal: optionalString(args, "original_goal", CHECKPOINT_TEXT_LIMIT),
      original_constraints: optionalString(
        args,
        "original_constraints",
        CHECKPOINT_TEXT_LIMIT,
      ),
      original_acceptance: optionalString(
        args,
        "original_acceptance",
        CHECKPOINT_TEXT_LIMIT,
      ),
      effective_goal: optionalString(args, "effective_goal", CHECKPOINT_TEXT_LIMIT),
      current_amendment: currentAmendment,
      current_understanding: optionalString(
        args,
        "current_understanding",
        CHECKPOINT_TEXT_LIMIT,
      ),
      current_decision: optionalString(args, "current_decision", CHECKPOINT_TEXT_LIMIT),
      acceptance_status: optionalString(
        args,
        "acceptance_status",
        CHECKPOINT_TEXT_LIMIT,
      ),
      next_step: optionalString(args, "next_step", CHECKPOINT_TEXT_LIMIT),
    });
    return {
      source: "local_codex_bridge_checkpoint",
      found: true,
      operation: result.operation,
      checkpoint: result.checkpoint,
    };
  }

  #checkpointStore(): CheckpointStore {
    this.checkpoints ??= new CheckpointStore();
    return this.checkpoints;
  }

  async #threads(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "include_turns", "cwd", "search_term", "cursor", "limit"]);
    const threadId = optionalString(args, "thread_id", 200);
    if (threadId) {
      if (args.cwd !== undefined || args.search_term !== undefined || args.cursor !== undefined || args.limit !== undefined) {
        throw new Error("thread_id cannot be combined with list/search fields");
      }
      const includeTurns = optionalBoolean(args, "include_turns") ?? false;
      const result = await this.appServer.request("thread/read", {
        threadId,
        includeTurns,
      });
      return sanitizeForTransport({ source: "codex_app_server", mode: "read", ...responseRecord(result, "thread/read") });
    }
    if (args.include_turns !== undefined) {
      throw new Error("include_turns is valid only with thread_id");
    }
    const cwdInput = optionalString(args, "cwd", 1_000);
    const cwd = cwdInput ? validateCwd(cwdInput) : undefined;
    const searchTerm = optionalString(args, "search_term", 500);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 20;
    const result = await this.appServer.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = responseRecord(result, "thread/list");
    if (!Array.isArray(page.data)) {
      throw new Error("thread/list returned no data array");
    }
    return {
      source: "codex_app_server",
      mode: "list",
      nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
      backwardsCursor: typeof page.backwardsCursor === "string" ? page.backwardsCursor : null,
      data: page.data.map((thread) => sanitizeForTransport(thread, {
        maxStringChars: 4_000,
        maxDepth: 6,
        maxArrayItems: 20,
        maxObjectKeys: 60,
        totalCharBudget: 12_000,
      })),
    };
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy"]);
    const text = requiredString(args, "text");
    const requestedThreadId = optionalString(args, "thread_id", 200);
    const cwdInput = optionalString(args, "cwd", 1_000);
    if (!requestedThreadId && !cwdInput) {
      throw new Error("cwd is required when thread_id is omitted");
    }
    const cwd = cwdInput ? validateCwd(cwdInput) : undefined;
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    const overrides = {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };

    const threadResult = requestedThreadId
      ? await this.appServer.request("thread/resume", {
          threadId: requestedThreadId,
          ...overrides,
        })
      : await this.appServer.request("thread/start", {
          ...overrides,
          serviceName: "local-codex-bridge",
        });
    const threadMethod = requestedThreadId ? "thread/resume" : "thread/start";
    const threadId = extractThreadId(threadResult, threadMethod);
    if (requestedThreadId && threadId !== requestedThreadId) {
      throw new Error("thread/resume returned a different thread id");
    }
    const sandboxPolicy = sandbox
      ? extractSandboxPolicy(threadResult, threadMethod, sandbox)
      : undefined;
    this.appServer.runtime.ensureThread(threadId);
    const turnResult = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    });
    const turnId = extractTurnId(turnResult, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    const turn = asObject(turnResult, "turn/start result").turn as Record<string, unknown>;
    return {
      accepted: true,
      thread_id: threadId,
      turn_id: turnId,
      event_cursor: this.appServer.runtime.currentCursor(threadId),
      status: typeof turn.status === "string" ? turn.status : "inProgress",
    };
  }

  async #observe(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    onlyKeys(args, ["thread_id", "cursor", "limit", "wait_ms"]);
    const threadId = requiredString(args, "thread_id", 200);
    const cursor = optionalInteger(args, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 50;
    const waitMs = optionalInteger(args, "wait_ms", 0, MAX_OBSERVE_WAIT_MS) ?? 0;
    const runtime = waitMs === 0
      ? this.appServer.runtime.observe(threadId, cursor, limit)
      : await this.appServer.runtime.observeWithWait(threadId, cursor, limit, waitMs, signal);
    throwIfAborted(signal);
    if (runtime) {
      return runtime;
    }
    throwIfAborted(signal);
    const result = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    throwIfAborted(signal);
    return sanitizeForTransport({
      runtime_available: false,
      live_state_reconstructable: false,
      note: "This Bridge process has no in-memory runtime for the thread. Live event ring and pending requests cannot be reconstructed after process loss.",
      runtime_status: "not_reconstructable",
      active_turn_id: null,
      events: [],
      next_cursor: 0,
      current_cursor: 0,
      cursor_floor: 0,
      cursor_lost: false,
      has_more: false,
      pending_requests: [],
      terminal: storedTerminal(result),
      stored_thread: responseRecord(result, "thread/read").thread,
      source: "codex_app_server_thread_read",
    });
  }

  async #steer(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "expected_turn_id", "text"]);
    const threadId = requiredString(args, "thread_id", 200);
    const expectedTurnId = requiredString(args, "expected_turn_id", 200);
    const text = requiredString(args, "text");
    const result = responseRecord(
      await this.appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text, text_elements: [] }],
      }),
      "turn/steer",
    );
    if (typeof result.turnId !== "string" || result.turnId.length === 0) {
      throw new Error("turn/steer returned no turn id");
    }
    if (result.turnId !== expectedTurnId) {
      throw new Error("turn/steer returned a different turn id");
    }
    return { accepted: true, thread_id: threadId, turn_id: result.turnId };
  }

  async #respond(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, [
      "request_id",
      "thread_id",
      "turn_id",
      "method",
      "decision",
      "execpolicy_amendment",
      "answers",
      "response",
    ]);
    const requestIdValue = args.request_id;
    if (
      !(
        (typeof requestIdValue === "string" && requestIdValue.length > 0) ||
        (typeof requestIdValue === "number" && Number.isInteger(requestIdValue))
      )
    ) {
      throw new Error("request_id must preserve the original non-empty string or integer id");
    }
    const requestId = requestIdValue as RpcId;
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = optionalString(args, "turn_id", 200);
    const method = requiredString(args, "method", 300);
    if (!SUPPORTED_RESPOND_METHODS.has(method)) {
      throw new Error(`Unsupported app-server request method: ${method}; pending request remains observable`);
    }
    const decision = enumValue(args, "decision", ["accept", "acceptForSession", "decline", "cancel"] as const);
    const amendment = args.execpolicy_amendment;
    const answers = args.answers;
    const generic = args.response;
    const supplied = [decision !== undefined, amendment !== undefined, answers !== undefined, generic !== undefined].filter(Boolean).length;
    if (supplied !== 1) {
      throw new Error("Provide exactly one of decision, execpolicy_amendment, answers, or response");
    }

    let response: Record<string, unknown>;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      if (amendment !== undefined) {
        if (method !== "item/commandExecution/requestApproval" && method !== "execCommandApproval") {
          throw new Error("execpolicy_amendment is valid only for command approval");
        }
        if (!Array.isArray(amendment) || amendment.length === 0 || amendment.some((item) => typeof item !== "string")) {
          throw new Error("execpolicy_amendment must be a non-empty string array");
        }
        response = method === "execCommandApproval"
          ? {
              decision: {
                approved_execpolicy_amendment: {
                  proposed_execpolicy_amendment: amendment,
                },
              },
            }
          : {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: amendment,
                },
              },
            };
      } else if (decision) {
        if (method === "execCommandApproval" || method === "applyPatchApproval") {
          const legacyDecision = decision === "accept"
            ? "approved"
            : decision === "acceptForSession"
              ? "approved_for_session"
              : decision === "cancel"
                ? "abort"
                : { denied: { rejection: "declined by MCP client" } };
          response = { decision: legacyDecision };
        } else {
          response = { decision };
        }
      } else {
        throw new Error("Approval requests require decision or execpolicy_amendment");
      }
    } else if (method === "item/tool/requestUserInput") {
      response = answers !== undefined ? { answers: asObject(answers, "answers") } : asObject(generic, "response");
    } else {
      if (generic === undefined) {
        throw new Error("This request method requires a generic response object");
      }
      response = asObject(generic, "response");
    }

    const pending = this.appServer.runtime.claimPending(requestId, {
      threadId,
      method,
      ...(turnId ? { turnId } : {}),
    });
    if (pending.turnId && !turnId) {
      this.appServer.runtime.releasePending(pending);
      throw new Error("turn_id is required for this pending request");
    }
    try {
      await this.appServer.respond(requestId, response);
    } catch (error) {
      this.appServer.runtime.releasePending(pending);
      throw error;
    }
    this.appServer.runtime.completePending(pending);
    return {
      responded: true,
      request_id: requestId,
      thread_id: threadId,
      turn_id: pending.turnId ?? null,
      method,
    };
  }

  async #interrupt(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "turn_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = requiredString(args, "turn_id", 200);
    await this.appServer.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, thread_id: threadId, turn_id: turnId };
  }
}
