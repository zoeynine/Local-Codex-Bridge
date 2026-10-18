import { preflightEcho } from "./exact-json.js";
import { AppServerManager, diagnoseCodexVersion } from "./app-server.js";
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
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";
import { exactHistoryResponse, validateHistoryPage } from "./history.js";
import { exactGoalResponse, MAX_GOAL_RESULT_BYTES, GOAL_STATUSES } from "./goal.js";
import { exactQueueResponse, MAX_QUEUE_RESULT_BYTES, QUEUE_ACTIONS, QUEUE_PAGE_LIMIT } from "./queue.js";
import { exactSearchResponse, SEARCH_PAGE_LIMIT } from "./search.js";

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

const NATIVE_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-request",
  "never",
]);

type PublicApprovalPolicy = "untrusted" | "on-request" | "never";

const SUPPORTED_RESPOND_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
]);

const MODEL_LIST_PAGE_LIMIT = 100;
const MAX_MODEL_CATALOG_PAGES = 100;
const MAX_MODEL_CATALOG_ENTRIES = 10_000;
const HISTORY_TURN_LIMIT = 50;
const HISTORY_ITEM_LIMIT = 20;
const THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
] as const;
const THREAD_LIST_FIELDS = [
  "cwd", "search_term", "cursor", "limit", "parent_thread_id", "ancestor_thread_id", "source_kinds",
] as const;

interface ModelListPage {
  data: Record<string, unknown>[];
  nextCursor: string | null;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "codex_threads",
    title: "Codex Threads",
    description:
      "List/search persistent native threads or read one thread's metadata. Use codex_history for turns; include_turns:true alone errors. Local latest_messages is a bounded degraded compatibility view. Capability and lineage fields are native metadata, not writer authorization. Include subagent source_kinds explicitly; native defaults to interactive sources. Metadata cannot reconstruct live Bridge state.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Read this exact thread instead of listing.",
        },
        include_turns: {
          type: "boolean",
          default: false,
          description: "Full turns are unbounded and disabled. When true, latest_messages (1..100) is required and history is explicitly degraded to metadata plus recent paginated messages.",
        },
        latest_messages: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "With thread_id, read up to this many newest user/agent messages through native items pagination (at most 20 pages of 100 items). Returned newest first; content is transport bounded.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Exact absolute native cwd filter.",
        },
        parent_thread_id: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "Direct spawned children, not forks; select subagent sources separately.",
        },
        ancestor_thread_id: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "Spawned descendants at any depth, excluding the ancestor; not forks.",
        },
        source_kinds: {
          type: ["array", "null"],
          items: { type: "string", enum: THREAD_SOURCE_KINDS },
          maxItems: 100,
          description: "Omitted/null/[] keeps native interactive defaults; include subAgentThreadSpawn for spawned threads.",
        },
        search_term: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Codex title substring filter.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Thread-list cursor only.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Thread page size.",
        },
      },
      oneOf: [
        { not: { anyOf: [{ required: ["thread_id"] }, { required: ["include_turns"] }, { required: ["latest_messages"] }] } },
        { required: ["thread_id"], not: { anyOf: THREAD_LIST_FIELDS.map((key) => ({ required: [key] })) } },
      ],
      not: {
        required: ["parent_thread_id", "ancestor_thread_id"],
        properties: { parent_thread_id: { type: "string" }, ancestor_thread_id: { type: "string" } },
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
    name: "codex_history",
    title: "Codex History",
    description:
      "Read one lossless native persisted history page; this does not restore Bridge live state. Paginated mode supports turns or items within a turn; legacy mode supports one full turn, without item paging. Keep History cursors within the same thread/mode/kind/turn/sort scope; only nextCursor:null ends paging. Size, content-policy, or structure failure rejects the whole page without partial data or fallback.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        kind: { type: "string", enum: ["turns", "items"] },
        content_policy: { type: "string", enum: ["protected", "exact"], default: "protected", description: "protected rejects secret-shaped content; exact exposes unchanged native text for this call. No fallback; neither value is an access-control level." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Native History cursor, not a thread-list, Search, or live Observe cursor." },
        limit: { type: "integer", minimum: 1, maximum: HISTORY_TURN_LIMIT, description: "Paginated turns default 20; items default 10/max 20; legacy turns require 1." },
        sort_direction: { type: "string", enum: ["asc", "desc"], description: "Turns default desc; items default asc. Use the opposite direction with a reverse cursor." },
      },
      required: ["thread_id", "kind"],
      oneOf: [
        { properties: { kind: { const: "turns" } }, not: { required: ["turn_id"] } },
        { properties: { kind: { const: "items" }, limit: { maximum: HISTORY_ITEM_LIMIT } }, required: ["turn_id"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Codex History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_search",
    title: "Search Native Codex History",
    description:
      "Search native threads or locate message occurrences within one paginated thread; use codex_history to read content. Thread search differs from the codex_threads title filter and does not infer a workspace or ACL. Occurrences are case-insensitive literal matches in visible user and final assistant messages, not every item. Preserve query/scope/filters across Search pages; only nextCursor:null ends paging. An occurrence turnCursor anchors same-thread History, not Search continuation. Content-policy, size, or structure failure rejects the whole page without partial data/cursor. Results are locators, not a full history audit.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["threads", "occurrences"] },
        content_policy: { type: "string", enum: ["protected", "exact"], default: "protected", description: "protected rejects secret-shaped content; exact exposes unchanged native text for this call. No fallback; neither value is an access-control level." },
        search_term: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S", description: "Native query, forwarded unchanged." },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Occurrences: exact native paginated thread." },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Search continuation for the same query/scope/filters; never use occurrence turnCursor." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_PAGE_LIMIT, default: 20 },
        sort_key: { type: ["string", "null"], enum: ["created_at", "updated_at", "recency_at", null], description: "Threads only; omission/null uses native created_at." },
        sort_direction: { type: ["string", "null"], enum: ["asc", "desc", null], description: "Threads only; omission/null uses native descending order. Use the opposite direction with backwardsCursor." },
        source_kinds: { type: ["array", "null"], items: { type: "string", enum: THREAD_SOURCE_KINDS }, maxItems: 100, description: "Threads only; omitted/null/[] keeps native interactive defaults. Select subagents explicitly." },
        archived: { type: ["boolean", "null"], description: "Threads only; true selects archived threads." },
      },
      required: ["kind", "search_term"],
      oneOf: [
        { properties: { kind: { const: "threads" } }, not: { required: ["thread_id"] } },
        { properties: { kind: { const: "occurrences" } }, required: ["thread_id"], not: { anyOf: ["sort_key", "sort_direction", "source_kinds", "archived"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: { title: "Search Native Codex History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "codex_models",
    title: "Codex Models",
    description:
      "Read one current native model/list page. The Bridge keeps no model catalog or current-model registry.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior model/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MODEL_LIST_PAGE_LIMIT,
          default: 20,
          description: "Maximum models in the returned page.",
        },
        include_hidden: {
          type: "boolean",
          default: false,
          description: "Request hidden models through native model/list includeHidden.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_goal",
    title: "Manage Native Codex Goal",
    description:
      "Get/set/clear one native persisted thread Goal; this does not start a turn or write a checkpoint. Active goals may cause native execution; clear does not interrupt a turn. Set requires budget_mode: preserve omits tokenBudget, unlimited sends null, fixed sends token_budget. goal_result_not_deliverable means acknowledged success without lossless delivery. A sent mutation timeout is UNKNOWN / possibly accepted: read native Goal state before deciding on another write; do not retry automatically.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "clear"] },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        objective: {
          type: ["string", "null"],
          description: "Set: forwarded unchanged; omission/null preserves the objective. Native enforces its text limit.",
        },
        status: { type: ["string", "null"], enum: [...GOAL_STATUSES, null], description: "Set: omission/null preserves native status." },
        budget_mode: { type: "string", enum: ["preserve", "unlimited", "fixed"], description: "preserve omits native tokenBudget; unlimited sends null; fixed uses token_budget." },
        token_budget: {
          type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
          description: "Native Goal resource ceiling for fixed mode. Maximum is a JavaScript lossless transport bound.",
        },
      },
      required: ["action", "thread_id"],
      oneOf: [
        { properties: { action: { const: "set" } }, required: ["budget_mode"], oneOf: [
          { properties: { budget_mode: { const: "fixed" } }, required: ["token_budget"] },
          { properties: { budget_mode: { enum: ["preserve", "unlimited"] } }, not: { required: ["token_budget"] } },
        ] },
        { properties: { action: { enum: ["get", "clear"] } }, not: { anyOf: ["objective", "status", "budget_mode", "token_budget"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Manage Native Codex Goal",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_queue",
    title: "Codex Native Queue",
    description:
      "List/add/update/delete/reorder native queued follow-up text. Queue runs after active work; codex_steer redirects the current turn. Enqueue acknowledgement is not execution or completion. Native may consume entries while you inspect them. queue_result_not_deliverable means acknowledged success without lossless delivery. A sent mutation timeout is UNKNOWN / possibly accepted: inspect queue and execution state before another write; do not retry automatically.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: QUEUE_ACTIONS },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        text: { type: "string", minLength: 1, maxLength: 200_000, pattern: "\\S", description: "Add text or full input replacement for update." },
        client_user_message_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Caller-provided native clientUserMessageId for add; Bridge never generates it." },
        queued_submission_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Native queuedSubmission.id, not a turn or client message id." },
        queued_submission_ids: { type: "array", maxItems: QUEUE_PAGE_LIMIT, items: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" }, description: "Full intended order of native pending submission IDs; no Bridge merge or deduplication." },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Native Queue-list cursor only." },
        limit: { type: "integer", minimum: 1, maximum: QUEUE_PAGE_LIMIT, default: 20, description: "Queue page size." },
      },
      required: ["action", "thread_id"],
      oneOf: [
        { properties: { action: { const: "list" } }, not: { anyOf: ["text", "client_user_message_id", "queued_submission_id", "queued_submission_ids"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "add" } }, required: ["text", "client_user_message_id"], not: { anyOf: ["queued_submission_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "update" } }, required: ["text", "queued_submission_id"], not: { anyOf: ["client_user_message_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "delete" } }, required: ["queued_submission_id"], not: { anyOf: ["text", "client_user_message_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "reorder" } }, required: ["queued_submission_ids"], not: { anyOf: ["text", "client_user_message_id", "queued_submission_id", "cursor", "limit"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Native Queue", readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: true,
    },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start a native persistent thread and turn, or resume a thread and start a turn. Acceptance is not completion; use codex_observe. A thread_id is not a permanent task identity. Model/effort overrides use a fresh native catalog; Codex decides current-model compatibility. A sent mutation timeout is UNKNOWN / possibly accepted: observe/read before another write; do not retry automatically.",
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
          description: "Absolute native cwd. Required for a new thread; optional override for resume.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Native model/list id or identifier; validated on demand.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "Without model, only catalog-wide availability is checked; Codex decides compatibility.",
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
      "Read bounded live Bridge events, pending requests, and terminal output; persistent content belongs to codex_history. Continue with next_cursor, never substitute cursor_floor after loss. stream_lost means evicted streaming deltas; facts_lost means evicted other supervision events; cursor_lost summarizes either. Raw shows retained events, not a complete native stream. When runtime_available:true, pending_requests is a full snapshot and absence in compact means empty; when runtime_available:false, pending state is unknown. Judge terminals by terminal.status, not final_result or error presence. terminal.final_result_pending means continue via next_cursor for final content; incomplete final_result_meta needs History/native inspection. wait_ms is one bounded wait. No command output alone does not mean stalled. While inProgress, continue repeated bounded observe calls; after each wake/deadline inspect new state before choosing steer, respond, or interrupt.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Thread with live Bridge state." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Live numeric cursor; continue from next_cursor. Older values replay retained events; cursor_floor is not continuation.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Returned fact/event page size; loss may cover more than this page.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OBSERVE_WAIT_MS,
          default: 0,
          description:
            "One bounded wait; 0 reads immediately. Compact wakes for supervision facts or facts_lost, not stream_lost alone; waiting is not stall detection.",
        },
        view: {
          type: "string",
          enum: ["compact", "raw"],
          default: "compact",
          description: "Raw shows retained sanitized events with possible cursor gaps; neither view restores evicted events.",
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
      "Redirect or correct the exact active turn; this does not start a new turn. Do not steer for silence or elapsed time alone. A sent mutation timeout is UNKNOWN / possibly accepted: observe/read before another write; do not retry automatically.",
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
      "Answer one pending native request using its original typed request id and exact method, thread, and turn scope when applicable. Supported approval and user-input methods use their native response shapes. Unsupported methods fail locally and remain pending; do not guess a response shape.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, maxLength: 300, description: "Supported: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput; legacy: execCommandApproval, applyPatchApproval." },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"],
          description: "Command or file approval decision. decline rejects the action and continues the current turn; cancel rejects the action and immediately interrupts the current turn.",
        },
        execpolicy_amendment: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Command approval exec-policy amendment; encoded in app-server's native decision shape.",
        },
        network_policy_amendment: {
          type: "object",
          properties: {
            host: { type: "string", minLength: 1 },
            action: { type: "string", enum: ["allow", "deny"] },
          },
          required: ["host", "action"],
          additionalProperties: false,
          description: "Future network policy amendment for item/commandExecution/requestApproval only; use one response field per call.",
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
        permissions: {
          type: "object",
          additionalProperties: true,
          description: "Granted subset for item/permissions/requestApproval. An empty object grants none of the requested permissions.",
        },
        scope: {
          type: "string",
          enum: ["turn", "session"],
          description: "Optional permission grant scope; omit or use turn for the current turn, or session for the session.",
        },
        response: {
          type: "object",
          additionalProperties: true,
          description: "Exact result object for item/tool/requestUserInput; unsupported methods remain pending.",
        },
      },
      required: ["request_id", "thread_id", "method"],
      anyOf: [
        { required: ["decision"] },
        { required: ["execpolicy_amendment"] },
        { required: ["network_policy_amendment"] },
        { required: ["answers"] },
        { required: ["permissions"] },
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
      "Interrupt the exact active native turn, without stopping Bridge or app-server. A sent mutation timeout is UNKNOWN / possibly accepted: observe/read before another write; do not retry automatically.",
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
      "Optional bounded supervisor anchor keyed to a native thread; it is not a task identity or native Goal. Create early for long/complex supervision with expected context dilution or goal drift; skip one-shot work. Window changes, elapsed time, poll count, and silence are not mechanical triggers. Preserve original goal, constraints, and acceptance unchanged; update concise supervisor state only on material decisions. Do not store transcripts, raw events, or command output. Before final acceptance of a checkpointed task, read it once.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update"],
          description:
            "Read or initialize/update at a material supervisor decision.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_THREAD_ID_LIMIT,
          description: "Native thread id; not a separate task identity.",
        },
        original_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Original user goal; required on initialization, immutable afterward.",
        },
        original_constraints: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Original constraints; required on initialization, immutable afterward.",
        },
        original_acceptance: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Original acceptance criteria; required on initialization, immutable afterward.",
        },
        effective_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Effective goal after user amendments; initially original_goal.",
        },
        current_amendment: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: CHECKPOINT_TEXT_LIMIT },
            { type: "null" },
          ],
          description:
            "Latest user-authorized amendment; null clears it without changing the original.",
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
            "Acceptance assessment, not a task lifecycle status.",
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

function responseRecord(value: unknown, method: string): Record<string, unknown> {
  const record = asObject(value, `${method} response`);
  return record;
}

function modelListPage(value: unknown, maximumEntries: number): ModelListPage {
  const page = responseRecord(value, "model/list");
  if (!Array.isArray(page.data)) {
    throw new Error("model/list returned no data array");
  }
  if (page.data.length > maximumEntries) {
    throw new Error(`model/list returned more than the requested ${maximumEntries} entries`);
  }
  const data = page.data.map((entry, index) => asObject(entry, `model/list data[${index}]`));
  const rawNextCursor = page.nextCursor;
  if (rawNextCursor === undefined || rawNextCursor === null) {
    return { data, nextCursor: null };
  }
  if (
    typeof rawNextCursor !== "string" ||
    rawNextCursor.length === 0 ||
    rawNextCursor.length > 10_000
  ) {
    throw new Error("model/list returned an invalid nextCursor");
  }
  return { data, nextCursor: rawNextCursor };
}

function sanitizedModelEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return asObject(
    sanitizeForTransport(entry, {
      maxStringChars: 4_000,
      maxDepth: 8,
      maxArrayItems: 40,
      maxObjectKeys: 80,
      totalCharBudget: 24_000,
    }),
    "sanitized model/list entry",
  );
}

function modelIdentifiers(entry: Record<string, unknown>): string[] {
  return [entry.id, entry.model].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function advertisedReasoningEfforts(
  entry: Record<string, unknown>,
): Set<string> | undefined {
  const advertised = entry.supportedReasoningEfforts;
  if (!Array.isArray(advertised)) {
    return undefined;
  }
  const efforts = new Set<string>();
  for (const option of advertised) {
    if (typeof option === "string" && option.length > 0) {
      efforts.add(option);
      continue;
    }
    if (option !== null && typeof option === "object" && !Array.isArray(option)) {
      const reasoningEffort = (option as Record<string, unknown>).reasoningEffort;
      if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) {
        efforts.add(reasoningEffort);
        continue;
      }
    }
    return undefined;
  }
  return efforts;
}

function formattedEfforts(efforts: ReadonlySet<string>): string {
  const sorted = [...efforts].sort();
  return sorted.length > 0 ? sorted.join(", ") : "(none advertised)";
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

function extractApprovalPolicy(
  result: unknown,
  method: string,
  requestedApprovalPolicy: PublicApprovalPolicy,
): PublicApprovalPolicy {
  const effectiveApprovalPolicy = asObject(result, `${method} result`).approvalPolicy;
  if (typeof effectiveApprovalPolicy !== "string") {
    throw new Error(
      `${method} returned no usable effective approvalPolicy for requested ${requestedApprovalPolicy}`,
    );
  }
  if (!NATIVE_APPROVAL_POLICIES.has(effectiveApprovalPolicy)) {
    throw new Error(
      `${method} returned unrecognized effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)}`,
    );
  }
  if (effectiveApprovalPolicy !== requestedApprovalPolicy) {
    throw new Error(
      `${method} returned effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)} for requested ${JSON.stringify(requestedApprovalPolicy)}`,
    );
  }
  return effectiveApprovalPolicy;
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
    private readonly platformPolicy: PlatformPolicy = platformPolicyFor(),
  ) {
    this.checkpoints = checkpoints;
  }

  async #readHistory(threadId: string, includeTurns: boolean): Promise<{ result: unknown; degradation?: Record<string, unknown> }> {
    // thread/read has no limit or cursor. Read metadata only; bounded messages use items/list.
    const result = await this.appServer.request("thread/read", { threadId, includeTurns: false });
    const thread = asObject(responseRecord(result, "thread/read").thread, "thread/read thread");
    if (thread.id !== threadId) throw new Error("thread/read returned mismatched thread identity");
    if (!includeTurns) return { result };
    const binary = this.appServer.binaryDiagnostics;
    return { result, degradation: {
      history_available: false,
      compatibility: {
        classification: "unbounded_history_disabled",
        ...binary,
        thread_cli_version: typeof thread.cliVersion === "string" ? thread.cliVersion : null,
        version_diagnostic: diagnoseCodexVersion(binary.cli_version, typeof thread.cliVersion === "string" ? thread.cliVersion : ""),
        remediation: "Full history is unavailable: thread/read has no limit/cursor. Use codex_history for native persisted history, codex_threads with thread_id and latest_messages (1..100) for the bounded local compatibility view, or the Desktop UI. No full turns or terminal are reconstructed.",
      },
    } };
  }

  #cwd(args: Record<string, unknown>): string | undefined {
    const input = optionalString(args, "cwd", 1_000);
    return input ? this.platformPolicy.validateCwd(input) : undefined;
  }

  async call(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = asObject(rawArguments ?? {});
    switch (name) {
      case "codex_history":
        return this.#history(args);
      case "codex_threads":
        return await this.#threads(args);
      case "codex_models":
        return await this.#models(args);
      case "codex_goal":
        return await this.#goal(args);
      case "codex_queue":
        return this.#queue(args);
      case "codex_search":
        return this.#search(args);
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

  async #history(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "kind", "turn_id", "cursor", "limit", "sort_direction", "content_policy"]);
    const policy = enumValue(args, "content_policy", ["protected", "exact"] as const) ?? "protected";
    const threadId = requiredString(args, "thread_id", 200);
    const kind = enumValue(args, "kind", ["turns", "items"]);
    if (kind === undefined) throw new Error("kind is required");
    if (kind === "turns" && Object.hasOwn(args, "turn_id")) {
      throw new Error("turn_id is valid only for items");
    }
    const turnId = kind === "items" ? requiredString(args, "turn_id", 200) : undefined;
    const cursor = optionalString(args, "cursor", 10_000);
    const requestedLimit = optionalInteger(args, "limit", 1, kind === "turns" ? HISTORY_TURN_LIMIT : HISTORY_ITEM_LIMIT);
    const sortDirection = enumValue(args, "sort_direction", ["asc", "desc"])
      ?? (kind === "turns" ? "desc" : "asc");

    // Native mode is read on demand, never cached in Bridge live state.
    const metadata = await this.appServer.request("thread/read", { threadId, includeTurns: false });
    const thread = asObject(responseRecord(metadata, "thread/read").thread, "thread/read result.thread");
    const historyMode = thread.historyMode;
    if (thread.id !== threadId || (historyMode !== "paginated" && historyMode !== "legacy")) {
      throw new Error("history_upstream_invalid: metadata must identify the requested thread and a supported historyMode");
    }
    if (historyMode === "legacy") {
      if (kind === "items") {
        throw new Error("history_legacy_item_paging_unsupported: use codex_history with kind:'turns' for native one-full-turn pages; legacy has no item cursor");
      }
      if (requestedLimit !== undefined && requestedLimit !== 1) {
        throw new Error("legacy history turn pages require limit:1");
      }
    }
    const limit = requestedLimit ?? (historyMode === "legacy" ? 1 : kind === "turns" ? 20 : 10);
    const itemsView = historyMode === "legacy" ? "full" : "notLoaded";
    const page = validateHistoryPage(await this.appServer.request(
      kind === "turns" ? "thread/turns/list" : "thread/items/list",
      {
        threadId,
        ...(turnId ? { turnId } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
        sortDirection,
        ...(kind === "turns" ? { itemsView } : {}),
      },
    ), limit, kind);
    return exactHistoryResponse({
      source: "codex_app_server",
      mode: "history",
      coverage: "native_persisted_history",
      history_mode: historyMode,
      kind,
      page_granularity: kind === "turns" ? "turn" : "item",
      ...(kind === "turns" ? { items_view: itemsView } : {}),
      thread_id: threadId,
      ...(turnId ? { turn_id: turnId } : {}),
      data: page.data,
      nextCursor: page.nextCursor,
      backwardsCursor: page.backwardsCursor,
    }, policy);
  }

  async #search(args: Record<string, unknown>): Promise<unknown> {
    const kind = enumValue(args, "kind", ["threads", "occurrences"] as const);
    if (!kind) throw new Error("kind is required");
    const policy = enumValue(args, "content_policy", ["protected", "exact"] as const) ?? "protected";
    onlyKeys(args, ["kind", "search_term", "cursor", "limit", "content_policy", ...(kind === "threads"
      ? ["sort_key", "sort_direction", "source_kinds", "archived"] : ["thread_id"])]);
    const limit = optionalInteger(args, "limit", 1, SEARCH_PAGE_LIMIT) ?? 20;
    const params: Record<string, unknown> = { searchTerm: requiredString(args, "search_term", 500), limit };
    const cursor = optionalString(args, "cursor", 10_000);
    if (cursor !== undefined) params.cursor = cursor;
    if (kind === "occurrences") {
      params.threadId = requiredString(args, "thread_id", 200);
    } else {
      const sortKey = args.sort_key === null ? null : enumValue(args, "sort_key", ["created_at", "updated_at", "recency_at"] as const);
      const sortDirection = args.sort_direction === null ? null : enumValue(args, "sort_direction", ["asc", "desc"] as const);
      const archived = args.archived === null ? null : optionalBoolean(args, "archived");
      const sourceKinds = args.source_kinds;
      if (sourceKinds !== undefined && sourceKinds !== null && (
        !Array.isArray(sourceKinds) || sourceKinds.length > 100 ||
        sourceKinds.some(value => typeof value !== "string" || !(THREAD_SOURCE_KINDS as readonly string[]).includes(value))
      )) throw new Error("source_kinds must be null or an array of at most 100 native source kinds");
      if (sortKey !== undefined) params.sortKey = sortKey;
      if (sortDirection !== undefined) params.sortDirection = sortDirection;
      if (archived !== undefined) params.archived = archived;
      if (sourceKinds !== undefined) params.sourceKinds = sourceKinds;
    }
    const method = kind === "threads" ? "thread/search" : "thread/searchOccurrences";
    return exactSearchResponse(await this.appServer.request(method, params), kind, limit, policy);
  }

  async #threads(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "include_turns", "latest_messages", ...THREAD_LIST_FIELDS]);
    const threadId = optionalString(args, "thread_id", 200);
    if (threadId) {
      if (THREAD_LIST_FIELDS.some((key) => Object.hasOwn(args, key))) {
        throw new Error("thread_id cannot be combined with list/search fields");
      }
      const includeTurns = optionalBoolean(args, "include_turns") ?? false;
      const latestMessages = optionalInteger(args, "latest_messages", 1, 100);
      if (includeTurns && latestMessages === undefined) {
        throw new Error("include_turns:true unbounded history is disabled; use codex_history or provide latest_messages (1..100) for explicitly degraded bounded history");
      }
      const { result, degradation } = await this.#readHistory(threadId, includeTurns);
      const recent = latestMessages === undefined ? {} : { recent_messages: await this.#latestMessages(threadId, latestMessages) };
      return sanitizeForTransport({ source: "codex_app_server", mode: "read", ...responseRecord(result, "thread/read"), ...degradation, ...recent }, { maxArrayItems: 100 });
    }
    if (args.latest_messages !== undefined) throw new Error("latest_messages is valid only with thread_id");
    if (Object.hasOwn(args, "include_turns")) {
      throw new Error("include_turns is valid only with thread_id");
    }
    const cwd = this.#cwd(args);
    const searchTerm = optionalString(args, "search_term", 500);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 20;
    const parentThreadId = args.parent_thread_id === null ? null : optionalString(args, "parent_thread_id", 200);
    const ancestorThreadId = args.ancestor_thread_id === null ? null : optionalString(args, "ancestor_thread_id", 200);
    if (parentThreadId != null && ancestorThreadId != null) {
      throw new Error("parent_thread_id and ancestor_thread_id are mutually exclusive");
    }
    const sourceKinds = args.source_kinds;
    if (sourceKinds !== undefined && sourceKinds !== null && (
      !Array.isArray(sourceKinds) || sourceKinds.length > 100 ||
      sourceKinds.some((kind) => typeof kind !== "string" || !(THREAD_SOURCE_KINDS as readonly string[]).includes(kind))
    )) {
      throw new Error("source_kinds must be null or an array of at most 100 native source kinds");
    }
    const result = await this.appServer.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
      ...(parentThreadId !== undefined ? { parentThreadId } : {}),
      ...(ancestorThreadId !== undefined ? { ancestorThreadId } : {}),
      ...(sourceKinds !== undefined ? { sourceKinds } : {}),
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

  async #latestMessages(threadId: string, limit: number): Promise<unknown> {
    const messages: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    const itemIds = new Set<string>();
    let cursor: string | undefined;
    let exhausted = false;
    let pages = 0;
    try {
      for (; pages < 20;) {
        const page = responseRecord(await this.appServer.request("thread/items/list", {
          threadId, limit: 100, sortDirection: "desc", ...(cursor ? { cursor } : {}),
        }), "thread/items/list");
        pages += 1;
        // Native entries omit threadId: the validated metadata and exact request scope bind them.
        if (page.threadId !== undefined && page.threadId !== threadId) throw new Error("thread/items/list returned mismatched thread identity");
        if (!Array.isArray(page.data) || page.data.length > 100) throw new Error("thread/items/list returned invalid data page");
        if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 10_000)) throw new Error("thread/items/list returned invalid cursor");
        for (const raw of page.data) {
          const entry = asObject(raw, "thread/items/list entry");
          const item = asObject(entry.item, "thread/items/list item");
          if (entry.threadId !== undefined && entry.threadId !== threadId) throw new Error("thread/items/list returned mismatched thread identity");
          if (typeof entry.turnId !== "string" || !entry.turnId || typeof item.id !== "string" || !item.id || typeof item.type !== "string") throw new Error("thread/items/list returned invalid item identity");
          if (itemIds.has(item.id)) throw new Error("thread/items/list returned duplicate item identity");
          itemIds.add(item.id);
          if (["userMessage", "agentMessage"].includes(item.type) && messages.length < limit) messages.push(entry);
        }
        exhausted = page.nextCursor === null;
        if (messages.length === limit || exhausted) break;
        cursor = page.nextCursor as string;
        if (cursors.has(cursor)) throw new Error("thread/items/list returned cursor cycle");
        cursors.add(cursor);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknown = message.match(/unknown variant [`'"]([A-Za-z][A-Za-z0-9_]{0,100})[`'"]/);
      if (!unknown && !/method not found|unknown method|unsupported method/i.test(message)) throw error;
      return { source: "codex_app_server_thread_items_list", thread_id: threadId, order: "newest_first", available: false, complete: false, messages: [], compatibility: { classification: unknown ? "stored_item_incompatible" : "native_paging_unavailable", ...(unknown ? { unknown_item: unknown[1] } : {}) } };
    }
    return { source: "codex_app_server_thread_items_list", thread_id: threadId, order: "newest_first", available: true, complete: messages.length === limit || exhausted, scan_limit_reached: messages.length < limit && !exhausted, requested: limit, pages_read: pages, messages };
  }

  async #models(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["cursor", "limit", "include_hidden"]);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, MODEL_LIST_PAGE_LIMIT) ?? 20;
    const includeHidden = optionalBoolean(args, "include_hidden") ?? false;
    const page = modelListPage(
      await this.appServer.request("model/list", {
        limit,
        includeHidden,
        ...(cursor ? { cursor } : {}),
      }),
      limit,
    );
    return {
      source: "codex_app_server_model_list",
      data: page.data.map(sanitizedModelEntry),
      nextCursor: page.nextCursor,
    };
  }

  async #fullModelCatalog(): Promise<Record<string, unknown>[]> {
    const catalog: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_MODEL_CATALOG_PAGES; pageNumber += 1) {
      const page = modelListPage(
        await this.appServer.request("model/list", {
          limit: MODEL_LIST_PAGE_LIMIT,
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        }),
        MODEL_LIST_PAGE_LIMIT,
      );
      catalog.push(...page.data);
      if (catalog.length > MAX_MODEL_CATALOG_ENTRIES) {
        throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_ENTRIES} entries`);
      }
      if (page.nextCursor === null) {
        return catalog;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("model/list pagination cursor cycle detected");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_PAGES} pages`);
  }

  async #validateExecutionOverrides(
    model: string | undefined,
    effort: string | undefined,
  ): Promise<void> {
    if (!model && !effort) {
      return;
    }
    const catalog = await this.#fullModelCatalog();
    if (model) {
      const matches = catalog.filter((entry) => modelIdentifiers(entry).includes(model));
      if (matches.length === 0) {
        throw new Error(
          `Unknown model override ${JSON.stringify(model)}; current model/list catalog contains no matching id or model`,
        );
      }
      if (!effort) {
        return;
      }
      const advertised = matches.map(advertisedReasoningEfforts);
      if (advertised.some((efforts) => efforts === undefined)) {
        return;
      }
      const supported = new Set(advertised.flatMap((efforts) => [...efforts!]));
      if (!supported.has(effort)) {
        throw new Error(
          `Unsupported effort ${JSON.stringify(effort)} for model ${JSON.stringify(model)}; advertised supportedReasoningEfforts: ${formattedEfforts(supported)}`,
        );
      }
      return;
    }

    const advertised = new Set<string>();
    for (const entry of catalog) {
      const efforts = advertisedReasoningEfforts(entry);
      if (efforts) {
        for (const candidate of efforts) {
          advertised.add(candidate);
        }
      }
    }
    if (!advertised.has(effort!)) {
      throw new Error(
        `Unknown effort override ${JSON.stringify(effort)}; it is absent from all advertised supportedReasoningEfforts in the current model/list catalog. The Bridge does not infer the current thread model. Advertised efforts: ${formattedEfforts(advertised)}`,
      );
    }
  }

  async #goal(args: Record<string, unknown>): Promise<unknown> {
    const action = enumValue(args, "action", ["get", "set", "clear"] as const);
    if (!action) throw new Error("action is required");
    onlyKeys(args, action === "set"
      ? ["action", "thread_id", "objective", "status", "budget_mode", "token_budget"]
      : ["action", "thread_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const params: Record<string, unknown> = { threadId };
    if (action === "set") {
      const mode = enumValue(args, "budget_mode", ["preserve", "unlimited", "fixed"] as const);
      if (!mode) throw new Error("budget_mode is required for set: choose preserve, unlimited, or fixed explicitly");
      if (mode === "fixed") {
        if (!Number.isSafeInteger(args.token_budget) || (args.token_budget as number) < 1) {
          throw new Error("fixed budget_mode requires a positive safe-integer token_budget; the maximum is a lossless transport bound");
        }
        params.tokenBudget = args.token_budget;
      } else {
        if (Object.hasOwn(args, "token_budget")) throw new Error("token_budget is accepted only with budget_mode=fixed");
        if (mode === "unlimited") params.tokenBudget = null;
      }
      if (args.objective !== undefined) {
        if (args.objective !== null && typeof args.objective !== "string") {
          throw new Error("objective must be a string or null");
        }
        // Native validates objective length/emptiness; do not introduce a
        // competing JavaScript character count, trim, or truncation rule.
        params.objective = args.objective;
      }
      if (args.status !== undefined) {
        params.status = args.status === null ? null : enumValue(args, "status", GOAL_STATUSES);
      }
    }
    if (action === "set" && typeof params.objective === "string") {
      preflightEcho({ goal: { threadId, objective: params.objective } }, MAX_GOAL_RESULT_BYTES, "goal");
    }
    const response = await this.appServer.request(`thread/goal/${action}`, params);
    return exactGoalResponse(response, action, threadId);
  }

  async #queue(args: Record<string, unknown>): Promise<unknown> {
    const action = enumValue(args, "action", QUEUE_ACTIONS);
    if (!action) throw new Error("action is required");
    const fields = {
      list: ["cursor", "limit"], add: ["text", "client_user_message_id"],
      update: ["text", "queued_submission_id"], delete: ["queued_submission_id"],
      reorder: ["queued_submission_ids"],
    };
    onlyKeys(args, ["action", "thread_id", ...fields[action]]);
    const params: Record<string, unknown> = { threadId: requiredString(args, "thread_id", 200) };
    const expected: { submissionId?: string; clientUserMessageId?: string } = {};
    if (action === "list") {
      params.limit = optionalInteger(args, "limit", 1, QUEUE_PAGE_LIMIT) ?? 20;
      const cursor = optionalString(args, "cursor", 10_000);
      if (cursor !== undefined) params.cursor = cursor;
    }
    if (action === "add" || action === "update") {
      params.input = [{ type: "text", text: requiredString(args, "text"), text_elements: [] }];
    }
    if (action === "add") {
      expected.clientUserMessageId = requiredString(args, "client_user_message_id", 200);
      params.clientUserMessageId = expected.clientUserMessageId;
    }
    if (action === "update" || action === "delete") {
      expected.submissionId = requiredString(args, "queued_submission_id", 200);
      params.queuedSubmissionId = expected.submissionId;
    }
    if (action === "reorder") {
      const ids = args.queued_submission_ids;
      if (!Array.isArray(ids) || ids.length > QUEUE_PAGE_LIMIT || ids.some(id =>
        typeof id !== "string" || id.trim().length === 0 || id.length > 200)) {
        throw new Error("queued_submission_ids must be an array of at most 100 non-empty native IDs, each at most 200 characters");
      }
      params.queuedSubmissionIds = ids;
    }
    if (action === "add" || action === "update") {
      const item = { id: expected.submissionId ?? "", input: params.input, clientUserMessageId: expected.clientUserMessageId ?? "" };
      // A one-item list must fit too; reserve covers currently unknown fields.
      preflightEcho({ data: [item], nextCursor: null }, MAX_QUEUE_RESULT_BYTES, "queue");
    }
    const response = await this.appServer.request("thread/queue/" + action, params);
    return exactQueueResponse(response, action, expected);
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy"]);
    const text = requiredString(args, "text");
    const requestedThreadId = optionalString(args, "thread_id", 200);
    const cwd = this.#cwd(args);
    if (!requestedThreadId && !cwd) {
      throw new Error(
        `cwd is required when thread_id is omitted and must be an ${this.platformPolicy.nativeCwdDescription}`,
      );
    }
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    await this.#validateExecutionOverrides(model, effort);
    const overrides = {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };

    const threadResult = requestedThreadId
      ? await this.appServer.request("thread/resume", {
          threadId: requestedThreadId,
          excludeTurns: true,
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
    const effectiveApprovalPolicy = approvalPolicy
      ? extractApprovalPolicy(threadResult, threadMethod, approvalPolicy)
      : undefined;
    this.appServer.runtime.ensureThread(threadId);
    const turnResult = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
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
    onlyKeys(args, ["thread_id", "cursor", "limit", "wait_ms", "view"]);
    const threadId = requiredString(args, "thread_id", 200);
    const cursor = optionalInteger(args, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 50;
    const waitMs = optionalInteger(args, "wait_ms", 0, MAX_OBSERVE_WAIT_MS) ?? 0;
    const view = args.view ?? "compact";
    if (view !== "compact" && view !== "raw") throw new Error("view must be compact or raw");
    const runtime = view === "compact"
      ? await this.appServer.runtime.observeCompactWithWait(threadId, cursor, limit, waitMs, signal)
      : waitMs === 0
        ? this.appServer.runtime.observe(threadId, cursor, limit)
        : await this.appServer.runtime.observeWithWait(threadId, cursor, limit, waitMs, signal);
    throwIfAborted(signal);
    if (runtime) {
      return runtime;
    }
    throwIfAborted(signal);
    const { result, degradation } = await this.#readHistory(threadId, true);
    throwIfAborted(signal);
    const storedThread = asObject(responseRecord(result, "thread/read").thread, "thread/read result.thread");
    return sanitizeForTransport({
      runtime_available: false,
      live_state_reconstructable: false,
      note: "This Bridge process has no live runtime for the thread. Live events, pending requests, live cursor, active turn, and terminal are unknown. Page persisted history with codex_history.",
      runtime_status: "not_reconstructable",
      active_turn_id: null,
      events: [],
      next_cursor: 0,
      current_cursor: 0,
      cursor_floor: 0,
      cursor_lost: false,
      stream_lost: false,
      facts_lost: false,
      has_more: false,
      pending_requests: [],
      terminal: null,
      unavailable_live_fields: ["active_turn_id", "terminal", "events", "next_cursor", "current_cursor", "cursor_floor", "cursor_lost", "stream_lost", "facts_lost", "has_more", "pending_requests"],
      stored_thread: { ...storedThread, turns: [] },
      source: "codex_app_server_thread_read_metadata",
      ...degradation,
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
      "network_policy_amendment",
      "answers",
      "permissions",
      "scope",
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
    const networkAmendment = args.network_policy_amendment;
    const answers = args.answers;
    const permissions = args.permissions;
    const scope = enumValue(args, "scope", ["turn", "session"] as const);
    const generic = args.response;
    if (networkAmendment !== undefined && method !== "item/commandExecution/requestApproval") {
      throw new Error("network_policy_amendment is valid only for item/commandExecution/requestApproval");
    }

    let response: Record<string, unknown> | undefined;
    if (method === "item/permissions/requestApproval") {
      if (permissions === undefined) {
        throw new Error("item/permissions/requestApproval requires permissions");
      }
      if (
        decision !== undefined ||
        amendment !== undefined ||
        answers !== undefined ||
        generic !== undefined
      ) {
        throw new Error("item/permissions/requestApproval accepts only permissions and optional scope");
      }
      response = {
        permissions: asObject(permissions, "permissions"),
        ...(scope ? { scope } : {}),
      };
    } else {
      if (permissions !== undefined || scope !== undefined) {
        throw new Error("permissions and scope are valid only for item/permissions/requestApproval");
      }
      const supplied = [
        decision !== undefined,
        amendment !== undefined,
        networkAmendment !== undefined,
        answers !== undefined,
        generic !== undefined,
      ].filter(Boolean).length;
      if (supplied !== 1) {
        throw new Error("Provide exactly one of decision, execpolicy_amendment, network_policy_amendment, answers, or response");
      }
    }

    if (method === "item/permissions/requestApproval") {
      // The exact stable response object was constructed above.
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      if (networkAmendment !== undefined) {
        const value = asObject(networkAmendment, "network_policy_amendment");
        onlyKeys(value, ["host", "action"]);
        const host = requiredString(value, "host");
        const action = enumValue(value, "action", ["allow", "deny"] as const);
        if (action === undefined) {
          throw new Error("network_policy_amendment requires action");
        }
        response = { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } } };
      } else if (amendment !== undefined) {
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
        throw new Error("Approval requests require decision, execpolicy_amendment, or network_policy_amendment");
      }
    } else if (method === "item/tool/requestUserInput") {
      response = answers !== undefined ? { answers: asObject(answers, "answers") } : asObject(generic, "response");
    } else {
      if (generic === undefined) {
        throw new Error("This request method requires a generic response object");
      }
      response = asObject(generic, "response");
    }
    if (!response) {
      throw new Error(`No response contract was constructed for ${method}`);
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
