import { sanitizeForTransport, stringHead, stringTail, type RuntimeEvent, type RuntimeObservation } from "./runtime.js";
import { ITEM_POLICIES, NOTIFICATION_POLICIES, type CompactPolicy } from "./compact-schema.js";
import { NOTIFICATION_SHAPES } from "./compact-descriptors.js";
import { matchesCompactShape } from "./compact-shape.js";
import { createHash } from "node:crypto";

export const COMPACT_EVENT_CHARS = 8_000;
export const COMPACT_BATCH_CHARS = 24_000;
export const COMPACT_DRAIN_CHUNK = 100;
export const COMPACT_DRAIN_CEILING = 2_048;
const FIELD_CHARS = 4_000;

export type Route = { wake: boolean; fact: Record<string, unknown> | null; activity?: string;
  lifecycle?: { key: string; state: "started" | "completed" } };
export interface CompactScope { threadId?: string; activeTurnId?: string }
export interface CompactFinalIdentity {
  itemCursor: number | null;
  terminalCursor: number | null;
  turnId: string | null;
  itemEvicted?: boolean;
  itemComplete?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function clipped(value: string, max = FIELD_CHARS): { value: string; truncated?: { original_chars: number; head_chars: number; tail_chars: number } } {
  if (value.length <= max) return { value };
  const head = stringHead(value, Math.floor(max / 2));
  const tail = stringTail(value, max - Math.floor(max / 2));
  return { value: head + tail, truncated: { original_chars: value.length, head_chars: head.length, tail_chars: tail.length } };
}

function assignClipped(fact: Record<string, unknown>, key: string, value: string, max = FIELD_CHARS): void {
  const bounded = clipped(value, max);
  fact[key] = bounded.value;
  if (bounded.truncated) fact[`${key}_truncation`] = bounded.truncated;
}

function boundedObject(event: RuntimeEvent, scope: CompactScope, type: "unknown" | "diagnostic_passthrough"): Record<string, unknown> {
  const source = record(event.data);
  const data: unknown = source ? { ...source } : event.data;
  const body = record(data);
  if (body && scope.threadId !== undefined && body.threadId === scope.threadId) delete body.threadId;
  if (body && scope.activeTurnId !== undefined && body.turnId === scope.activeTurnId) delete body.turnId;
  return {
    type, method: event.method,
    ...(typeof record(source?.item)?.type === "string" ? { native_item_type: record(source?.item)?.type } : {}),
    data: sanitizeForTransport(data, {
      maxStringChars: 2_000, maxDepth: 5, maxArrayItems: 12,
      maxObjectKeys: 25, totalCharBudget: 4_000,
    }),
  };
}

function unknown(event: RuntimeEvent, scope: CompactScope): Route {
  return { wake: true, fact: boundedObject(event, scope, "unknown") };
}

function scoped(data: Record<string, unknown>): boolean {
  return typeof data.threadId === "string" && typeof data.turnId === "string";
}

function streamed(data: Record<string, unknown>): boolean {
  return scoped(data) && typeof data.itemId === "string";
}

function itemShape(item: Record<string, unknown>): boolean {
  const type = item.type;
  return typeof type === "string" && Object.hasOwn(ITEM_POLICIES, type) && typeof item.id === "string";
}

function itemRoute(event: RuntimeEvent, data: Record<string, unknown>, scope: CompactScope): Route {
  const complete = event.method === "item/completed";
  const item = record(data.item);
  if (!scoped(data) || !Number.isInteger(data[complete ? "completedAtMs" : "startedAtMs"]) || !item || !itemShape(item)) return unknown(event, scope);
  const policy = ITEM_POLICIES[item.type as string];
  if (policy === "activity_only" || policy === "ignore_compact") return { wake: false, fact: null, ...(policy === "activity_only" ? { activity: item.type as string } : {}) };
  if (typeof policy === "object") return { wake: policy.wake, fact: boundedObject(event, scope, "diagnostic_passthrough") };
  const base: Record<string, unknown> = { type: item.type, item_id: item.id };
  if (item.type === "agentMessage") {
    if (!complete) return { wake: false, fact: null, activity: "agent_message_started" };
    if (item.phase != null && item.phase !== "commentary" && item.phase !== "partial_answer" && item.phase !== "final_answer") return unknown(event, scope);
    const fact = { type: "message", item_id: item.id, ...(item.phase ? { phase: item.phase } : {}) } as Record<string, unknown>;
    assignClipped(fact, "text", item.text as string);
    return { wake: true, fact };
  }
  if (item.type === "commandExecution") {
    const status = item.status as string;
    if (!["inProgress", "completed", "failed", "declined"].includes(status) || (complete ? status === "inProgress" : status !== "inProgress")) return unknown(event, scope);
    const failed = complete && (status === "failed" || status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0));
    const fact: Record<string, unknown> = { type: "command", item_id: item.id, lifecycle: complete ? "completed" : "started", state: status };
    assignClipped(fact, "command", item.command as string, 1_000);
    assignClipped(fact, "cwd", item.cwd as string, 500);
    if (complete) {
      if (typeof item.exitCode === "number" || item.exitCode === null) fact.exit_code = item.exitCode;
      if (typeof item.durationMs === "number") fact.duration_ms = item.durationMs;
      if (typeof item.aggregatedOutput === "string") {
        fact.output_chars = item.aggregatedOutput.length;
        if (failed) assignClipped(fact, "error_tail", item.aggregatedOutput.slice(-2_000), 2_000);
      }
    }
    return { wake: Boolean(failed), fact };
  }
  if (item.type === "fileChange") {
    const status = item.status as string;
    if (!["inProgress", "completed", "failed", "declined"].includes(status)) return unknown(event, scope);
    const changes = item.changes as unknown[];
    const paths = changes.map(record).map((change) => change?.path).filter((path): path is string => typeof path === "string");
    const fact: Record<string, unknown> = { ...base, type: "file", lifecycle: complete ? "completed" : "started", state: status, change_count: changes.length, paths: paths.slice(0, 20).map((path) => clipped(path, 500).value) };
    if (paths.length > 20) fact.paths_omitted = paths.length - 20;
    return { wake: complete && (status === "failed" || status === "declined"), fact };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const status = item.status as string;
    if (!["inProgress", "completed", "failed"].includes(status)) return unknown(event, scope);
    const failed = complete && (status === "failed" || item.success === false || item.error != null);
    const fact: Record<string, unknown> = { ...base, type: "tool", lifecycle: complete ? "completed" : "started", state: status };
    assignClipped(fact, "tool", item.tool as string, 500);
    if (typeof item.server === "string") assignClipped(fact, "server", item.server, 500);
    if (failed && item.error != null) assignClipped(fact, "error", JSON.stringify(item.error), 1_000);
    return { wake: Boolean(failed), fact };
  }
  if (item.type === "collabAgentToolCall") {
    const fact: Record<string, unknown> = { ...base, type: "collaboration", lifecycle: complete ? "completed" : "started", state: item.status, tool: item.tool, sender_thread_id: item.senderThreadId, receiver_thread_ids: (item.receiverThreadIds as unknown[]).filter((x) => typeof x === "string").slice(0, 12) };
    if (typeof item.model === "string") fact.model = item.model;
    return { wake: complete || item.status === "failed", fact };
  }
  if (item.type === "subAgentActivity") {
    return { wake: item.kind === "completed" || item.kind === "interrupted", fact: { ...base, type: "subagent", kind: item.kind, agent_thread_id: item.agentThreadId, ...(typeof item.agentPath === "string" ? { agent_path: clipped(item.agentPath, 500).value } : {}) } };
  }
  if (item.type === "webSearch") {
    const fact: Record<string, unknown> = { ...base, type: "web_search", lifecycle: complete ? "completed" : "started" };
    assignClipped(fact, "query", item.query as string, 500);
    return { wake: false, fact };
  }
  if (item.type === "plan") {
    if (!complete) return { wake: false, fact: null, activity: "plan_started" };
    const fact: Record<string, unknown> = { ...base, type: "plan" };
    assignClipped(fact, "text", item.text as string, 2_000);
    return { wake: true, fact };
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return { wake: complete, fact: { ...base, type: "review_mode", state: item.type, review: clipped(item.review as string, 500).value } };
  }
  if (item.type === "imageGeneration") {
    return { wake: complete && item.status === "failed", fact: { ...base, type: "image_generation", state: item.status, ...(typeof item.savedPath === "string" ? { path: clipped(item.savedPath, 500).value } : {}) } };
  }
  if (item.type === "sleep") return { wake: false, fact: { ...base, type: "sleep", duration_ms: item.durationMs } };
  return { wake: false, fact: null, activity: item.type as string };
}

const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval",
]);

function settingsRoute(event: RuntimeEvent, data: Record<string, unknown>, scope: CompactScope): Route {
  const settings = record(data.threadSettings);
  const sandbox = record(settings?.sandboxPolicy);
  const collaboration = record(settings?.collaborationMode);
  const modeSettings = record(collaboration?.settings);
  const approval = settings?.approvalPolicy;
  const granular = record(approval)?.granular;
  if (typeof data.threadId !== "string" || !settings || !sandbox ||
      !["dangerFullAccess", "readOnly", "externalSandbox", "workspaceWrite"].includes(String(sandbox.type)) ||
      !(approval === "untrusted" || approval === "on-request" || approval === "never" ||
        (record(granular) !== null && ["mcp_elicitations", "rules", "sandbox_approval"].every((key) => typeof record(granular)?.[key] === "boolean"))) ||
      !["user", "auto_review", "guardian_subagent"].includes(String(settings.approvalsReviewer)) ||
      typeof settings.cwd !== "string" || typeof settings.model !== "string" || typeof settings.modelProvider !== "string" ||
      !collaboration || !["default", "plan"].includes(String(collaboration.mode)) || typeof modeSettings?.model !== "string") return unknown(event, scope);
  if (event.compactSettingsChanged === false) return { wake: false, fact: null };
  const fact: Record<string, unknown> = {
    type: "settings", approval_policy: typeof approval === "string" ? approval : {
      mode: "granular", ...Object.fromEntries(["mcp_elicitations", "rules", "sandbox_approval", "request_permissions", "skill_approval"]
        .filter((key) => typeof record(granular)?.[key] === "boolean").map((key) => [key, record(granular)?.[key]])),
    },
    approvals_reviewer: settings.approvalsReviewer,
    sandbox: { type: sandbox.type,
      ...(typeof sandbox.networkAccess === "boolean" || typeof sandbox.networkAccess === "string" ? { network_access: sandbox.networkAccess } : {}),
      ...(Array.isArray(sandbox.writableRoots) ? { writable_roots: sandbox.writableRoots.filter((x) => typeof x === "string").slice(0, 12).map((x: string) => clipped(x, 500).value), roots_omitted: Math.max(0, sandbox.writableRoots.length - 12) } : {}),
    },
    model: clipped(settings.model, 200).value,
    model_provider: clipped(settings.modelProvider, 200).value,
    collaboration_mode: collaboration.mode,
  };
  assignClipped(fact, "cwd", settings.cwd, 500);
  if (typeof settings.effort === "string") fact.effort = clipped(settings.effort, 100).value;
  const profile = record(settings.activePermissionProfile);
  if (typeof profile?.id === "string") fact.permission_profile = clipped(profile.id, 200).value;
  return { wake: event.compactBoundaryChanged !== false, fact };
}

function typedNotification(event: RuntimeEvent, data: Record<string, unknown>, scope: CompactScope): Route {
  const method = event.method;
  if (method === "thread/settings/updated") return settingsRoute(event, data, scope);
  if (method === "process/exited") {
    if (!Number.isInteger(data.exitCode) || typeof data.processHandle !== "string" ||
        typeof data.stdout !== "string" || typeof data.stderr !== "string" ||
        typeof data.stdoutCapReached !== "boolean" || typeof data.stderrCapReached !== "boolean") return unknown(event, scope);
    const failed = data.exitCode !== 0 || data.stdoutCapReached || data.stderrCapReached;
    if (!failed) return { wake: false, fact: null };
    const fact: Record<string, unknown> = { type: "process", state: "exited", process_handle: clipped(data.processHandle, 200).value,
      exit_code: data.exitCode, stdout_cap_reached: data.stdoutCapReached, stderr_cap_reached: data.stderrCapReached };
    const tail = (data.stderr || data.stdout).slice(-2_000);
    if (tail) assignClipped(fact, "error_tail", tail, 2_000);
    return { wake: true, fact };
  }
  if (method === "turn/plan/updated") {
    if (!scoped(data) || !Array.isArray(data.plan) || !data.plan.every((step) => typeof record(step)?.step === "string" && ["pending", "inProgress", "completed"].includes(String(record(step)?.status)))) return unknown(event, scope);
    if (event.compactPlanChanged === false) return { wake: false, fact: null };
    const fact: Record<string, unknown> = { type: "plan", steps: data.plan.slice(0, 30).map((step) => ({ step: clipped(String(record(step)?.step), 500).value, status: record(step)?.status })) };
    if (data.plan.length > 30) fact.steps_omitted = data.plan.length - 30;
    const explanation = data.explanation;
    if (typeof explanation === "string") assignClipped(fact, "explanation", explanation, 1_000);
    return { wake: true, fact };
  }
  if (method === "turn/started" || method === "thread/started") return { wake: false, fact: null, activity: method };
  if (method === "turn/completed") {
    const turn = record(data.turn);
    return typeof data.threadId === "string" && typeof turn?.id === "string" && Array.isArray(turn.items) &&
      ["completed", "failed", "interrupted"].includes(String(turn.status))
      ? { wake: true, fact: null } : unknown(event, scope);
  }
  if (method === "thread/status/changed") {
    const status = record(data.status);
    if (typeof data.threadId !== "string" || !status || !["active", "idle", "notLoaded", "systemError"].includes(String(status.type)) ||
        (status.type === "active" && !Array.isArray(status.activeFlags))) return unknown(event, scope);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags.filter((x) => typeof x === "string") : [];
    const wake = status.type === "systemError" || flags.length > 0;
    return wake ? { wake: true, fact: { type: "status", state: status.type, ...(flags.length ? { active_flags: flags } : {}) } }
      : { wake: false, fact: null, activity: "thread_status" };
  }
  if (method === "mcpServer/startupStatus/updated") {
    if (typeof data.name !== "string" || !["starting", "ready", "failed", "cancelled"].includes(String(data.status))) return unknown(event, scope);
    const fact: Record<string, unknown> = { type: "environment", method, name: clipped(data.name, 500).value, state: data.status };
    if (typeof data.error === "string") assignClipped(fact, "error", data.error, 1_000);
    return { wake: data.status === "failed" || data.status === "cancelled" || typeof data.error === "string" || data.failureReason === "reauthenticationRequired", fact };
  }
  if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    const review = record(data.review); const action = record(data.action);
    if (!scoped(data) || typeof data.reviewId !== "string" || !review || !action ||
        !["inProgress", "approved", "denied", "timedOut", "aborted"].includes(String(review.status)) ||
        !["command", "execve", "writeStdin", "applyPatch", "networkAccess", "mcpToolCall", "requestPermissions"].includes(String(action.type))) return unknown(event, scope);
    const fact: Record<string, unknown> = { type: "auto_approval_review", state: method.endsWith("/completed") ? "completed" : "started", review_id: data.reviewId, review_status: review.status, action_type: action.type };
    if (typeof data.targetItemId === "string") fact.target_item_id = data.targetItemId;
    if (typeof review.riskLevel === "string") fact.risk_level = review.riskLevel;
    if (typeof review.userAuthorization === "string") fact.user_authorization = review.userAuthorization;
    if (typeof data.decisionSource === "string") fact.decision_source = data.decisionSource;
    if (typeof action.command === "string") assignClipped(fact, "command", action.command, 1_000);
    if (typeof action.cwd === "string") assignClipped(fact, "cwd", action.cwd, 500);
    if (Array.isArray(action.files)) fact.paths = action.files.filter((x) => typeof x === "string").slice(0, 20);
    if (typeof action.target === "string") assignClipped(fact, "target", action.target, 500);
    if (typeof action.server === "string") fact.server = clipped(action.server, 500).value;
    if (typeof action.toolName === "string") fact.tool = clipped(action.toolName, 500).value;
    return { wake: true, fact };
  }
  if (method === "autoApprovalReview/strictReviewRequired") return scoped(data) && Number.isInteger(data.startedAtMs)
    ? { wake: true, fact: { type: "auto_approval_review", state: "strict_review_required" } } : unknown(event, scope);
  if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
    const message = method === "configWarning" ? data.summary : data.message;
    if (typeof message !== "string") return unknown(event, scope);
    const fact: Record<string, unknown> = { type: "warning", category: method };
    assignClipped(fact, "message", message, 2_000);
    if (method === "configWarning" && typeof data.details === "string") assignClipped(fact, "details", data.details, 1_000);
    if (method === "configWarning" && typeof data.path === "string") assignClipped(fact, "path", data.path, 500);
    return { wake: true, fact };
  }
  if (method === "windows/worldWritableWarning") return Array.isArray(data.samplePaths) && typeof data.extraCount === "number"
    ? { wake: true, fact: { type: "warning", category: method, sample_paths: data.samplePaths.filter((x) => typeof x === "string").slice(0, 10), extra_count: data.extraCount, failed_scan: data.failedScan === true } } : unknown(event, scope);
  if (method === "error" || method === "appServer/exited") {
    const fact: Record<string, unknown> = { type: "error", method };
    if (method === "appServer/exited" && typeof data.message === "string") assignClipped(fact, "message", data.message, 2_000);
    else if (record(data.error)) assignClipped(fact, "message", JSON.stringify(data.error), 2_000);
    else return unknown(event, scope);
    if (typeof data.willRetry === "boolean") fact.will_retry = data.willRetry;
    return { wake: true, fact };
  }
  if (method === "model/rerouted") {
    if (!scoped(data) || typeof data.fromModel !== "string" || typeof data.toModel !== "string") return unknown(event, scope);
    return { wake: true, fact: { type: "model", state: "rerouted", from_model: data.fromModel, to_model: data.toModel, reason: data.reason } };
  }
  if (method === "model/verification") {
    if (!scoped(data) || !Array.isArray(data.verifications)) return unknown(event, scope);
    return { wake: true, fact: { type: "model", state: "verification", count: data.verifications.length } };
  }
  if (method === "model/safetyBuffering/updated") {
    if (!scoped(data) || typeof data.model !== "string" || !Array.isArray(data.reasons)) return unknown(event, scope);
    return { wake: true, fact: { type: "safety", state: "buffering", model: data.model, reasons: data.reasons.filter((x) => typeof x === "string").slice(0, 10), show_buffering_ui: data.showBufferingUi === true } };
  }
  return unknown(event, scope);
}

// Runs only against original input. Neither debug transport markers nor bounded
// facts are protocol values and must never be validated/routed as native input.
function routeOriginalEvent(event: RuntimeEvent, scope: CompactScope, shapeValid: boolean): Route {
  const data = record(event.data);
  if (!data) return unknown(event, scope);
  if (REQUEST_METHODS.has(event.method) && (typeof data.request_id === "string" || typeof data.request_id === "number") && "params" in data) {
    return { wake: true, fact: { type: "request", method: event.method, request_id: data.request_id } };
  }
  if (event.method === "appServer/lateResponseReconciled") return { wake: true, fact: { type: "status", method: event.method, action: data.action, reason: data.reason } };
  if (event.method === "appServer/unscopedRequest") return unknown(event, scope);
  if (event.method === "appServer/exited") return typedNotification(event, data, scope);
  const policy: CompactPolicy | undefined = NOTIFICATION_POLICIES[event.method];
  if (!policy) return unknown(event, scope);
  if (!shapeValid) return unknown(event, scope);
  if (policy === "ignore_compact") return { wake: false, fact: null };
  if (typeof policy === "object") return { wake: policy.wake, fact: boundedObject(event, scope, "diagnostic_passthrough") };
  if (event.method === "item/started" || event.method === "item/completed") return itemRoute(event, data, scope);
  if (policy === "activity_only") {
    if (event.method === "command/exec/outputDelta" || event.method === "process/outputDelta") return typeof data.deltaBase64 === "string" &&
      typeof data[event.method === "command/exec/outputDelta" ? "processId" : "processHandle"] === "string" &&
      (data.stream === "stdout" || data.stream === "stderr") && typeof data.capReached === "boolean"
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    if (event.method === "item/fileChange/patchUpdated") return streamed(data) && Array.isArray(data.changes) &&
      data.changes.every((change) => typeof record(change)?.path === "string" && typeof record(change)?.diff === "string")
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    if (event.method === "item/reasoning/summaryPartAdded") return streamed(data) && Number.isInteger(data.summaryIndex)
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    if (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/reasoning/textDelta") return streamed(data) && typeof data.delta === "string" &&
      Number.isInteger(data[event.method === "item/reasoning/summaryTextDelta" ? "summaryIndex" : "contentIndex"])
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    if (["item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(event.method)) return streamed(data) && typeof data.delta === "string"
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    if (event.method === "item/mcpToolCall/progress") return streamed(data) && typeof data.message === "string"
      ? { wake: false, fact: null, activity: event.method } : unknown(event, scope);
    return { wake: false, fact: null, activity: event.method };
  }
  return typedNotification(event, data, scope);
}

function boundedRoute(route: Route): Route {
  if (!route.fact) return route;
  // Semantic decisions and counts are already complete. Redact and bound only
  // the small projection before retaining it in the existing event ring.
  let fact = sanitizeForTransport(route.fact, {
    maxStringChars: FIELD_CHARS, maxDepth: 8, maxArrayItems: 30,
    maxObjectKeys: 50, totalCharBudget: COMPACT_EVENT_CHARS,
  }) as Record<string, unknown>;
  if (JSON.stringify(fact).length > COMPACT_EVENT_CHARS) {
    fact = sanitizeForTransport(fact, {
      maxStringChars: 500, maxDepth: 5, maxArrayItems: 8,
      maxObjectKeys: 20, totalCharBudget: 1_000,
    }) as Record<string, unknown>;
    fact.projection_truncated = true;
  }
  // Escaped strings/keys can exceed the sanitizer's character accounting.
  if (JSON.stringify(fact).length > COMPACT_EVENT_CHARS) {
    fact = { type: route.fact.type, projection_truncated: true };
  }
  return { ...route, fact };
}

export function prepareCompactRoute(event: RuntimeEvent, onValidShape?: () => void): Route {
  const shapeValid = matchesCompactShape(NOTIFICATION_SHAPES, event.method, event.data);
  if (shapeValid) onValidShape?.();
  const route = routeOriginalEvent(event, {}, shapeValid);
  if (typeof route.fact?.item_id === "string" && (route.fact.lifecycle === "started" || route.fact.lifecycle === "completed")) {
    route.lifecycle = { key: createHash("sha256").update(route.fact.item_id).digest("hex"), state: route.fact.lifecycle };
  }
  return boundedRoute(route);
}

export function routeCompactEvent(event: RuntimeEvent, scope: CompactScope = {}): Route {
  const route = event.compactRoute ?? prepareCompactRoute(event);
  // Scope is an observe-time fact. Copy before elision so replay and concurrent
  // observers never mutate the retained bounded projection.
  if (route.fact?.type === "unknown" || route.fact?.type === "diagnostic_passthrough") {
    const body = record(route.fact.data);
    if (body) {
      const data = { ...body };
      if (scope.threadId !== undefined && data.threadId === scope.threadId) delete data.threadId;
      if (scope.activeTurnId !== undefined && data.turnId === scope.activeTurnId) delete data.turnId;
      return { ...route, fact: { ...route.fact, data } };
    }
  }
  return { ...route };
}

export function hasCompactWake(observation: RuntimeObservation): boolean {
  return observation.facts_lost || observation.events.some((event) => routeCompactEvent(event).wake);
}

export class CompactAccumulator {
  readonly facts: Record<string, unknown>[] = [];
  readonly activity: Record<string, number> = {};
  readonly #started = new Map<string, number>();
  nextCursor: number;
  scanned = 0;
  wake = false;
  continuation: "fact_limit" | "event_budget" | "drainage_yield" | null = null;
  #usedChars = 0;

  constructor(readonly requestedCursor: number, readonly factLimit: number, readonly scope: CompactScope, scanCursor = requestedCursor) {
    this.nextCursor = scanCursor;
  }

  consume(event: RuntimeEvent): boolean {
    const route = routeCompactEvent(event, this.scope);
    const delivered = route.fact;
    const size = delivered ? JSON.stringify(delivered).length : 0;
    const id = route.lifecycle?.key;
    const priorIndex = id && route.lifecycle?.state === "completed" ? this.#started.get(id) : undefined;
    const priorSize = priorIndex === undefined ? 0 : JSON.stringify(this.facts[priorIndex]!).length;
    if (delivered && this.facts.length - (priorIndex === undefined ? 0 : 1) >= this.factLimit) { this.continuation = "fact_limit"; return false; }
    if (delivered && this.#usedChars - priorSize + size > COMPACT_BATCH_CHARS && this.facts.length > (priorIndex === undefined ? 0 : 1)) { this.continuation = "event_budget"; return false; }
    this.scanned += 1;
    this.nextCursor = event.cursor;
    if (route.activity) this.activity[route.activity] = (this.activity[route.activity] ?? 0) + 1;
    if (delivered) {
      if (id && priorIndex !== undefined) {
        const index = priorIndex;
        const old = this.facts[index];
        this.#usedChars -= JSON.stringify(old).length;
        this.facts.splice(index, 1);
        this.#started.delete(id);
        for (const [key, value] of this.#started) if (value > index) this.#started.set(key, value - 1);
      }
      if (id && route.lifecycle?.state === "started") this.#started.set(id, this.facts.length);
      this.facts.push(delivered);
      this.#usedChars += size;
    }
    this.wake ||= route.wake;
    return true;
  }

  result(snapshot: RuntimeObservation, final: CompactFinalIdentity | null, hasMore: boolean, streamLost: boolean, factsLost: boolean, cursorFloor: number): Record<string, unknown> {
    const terminal = snapshot.terminal;
    const terminalFact: Record<string, unknown> | null = terminal ? { turn_id: terminal.turn_id, status: terminal.status } : null;
    if (terminal && terminalFact && terminal.error != null) assignClipped(terminalFact, "error", JSON.stringify(terminal.error), 2_000);
    // Complete retained finals are delivered at their own cursor. An evicted final uses
    // that same cursor as its fallback boundary; a final without an item cursor
    // uses terminal completion. Neither loss nor floor may jump that boundary.
    if (terminal && terminalFact && terminal.final_result != null && final?.terminalCursor != null) {
      const completeItem = final.itemCursor != null && final.itemComplete !== false;
      const deliveryCursor = completeItem ? final.itemCursor! : final.terminalCursor;
      if (this.nextCursor < deliveryCursor) {
        // Status is current, but metadata must not describe content still ahead
        // of this page as if it had already been delivered.
        terminalFact.final_result_pending = true;
      } else {
        if (terminal.final_result_meta) terminalFact.final_result_meta = { ...terminal.final_result_meta };
        if (this.requestedCursor < deliveryCursor && (!completeItem || final.itemEvicted === true)) {
          // Existing bounded snapshot, outside ordinary event budgets.
          terminalFact.final_result = terminal.final_result;
        }
      }
    }
    return {
      runtime_available: true,
      runtime_status: snapshot.runtime_status,
      active_turn_id: snapshot.active_turn_id,
      next_cursor: this.nextCursor,
      ...(this.facts.length ? { events: this.facts } : {}),
      ...(Object.keys(this.activity).length ? { activity: this.activity } : {}),
      ...(streamLost || factsLost ? { cursor_lost: true, cursor_floor: cursorFloor } : {}),
      ...(streamLost ? { stream_lost: true } : {}),
      ...(factsLost ? { facts_lost: true } : {}),
      ...(hasMore || this.continuation ? { has_more: true } : {}),
      ...(this.continuation ? { continuation: this.continuation } : {}),
      ...(snapshot.pending_requests.length ? { pending_requests: snapshot.pending_requests } : {}),
      ...(terminalFact ? { terminal: terminalFact } : {}),
    };
  }
}

// One-page projection remains useful for deterministic fixtures. Public compact
// observe uses RuntimeStore's multi-chunk drain loop below this boundary.
export function projectCompact(observation: RuntimeObservation, requestedCursor: number | undefined, scope: CompactScope = {}, final: CompactFinalIdentity | null = null): Record<string, unknown> {
  const start = Math.min(requestedCursor ?? observation.cursor_floor, observation.current_cursor);
  const accumulator = new CompactAccumulator(requestedCursor ?? observation.cursor_floor, 100, scope, start);
  for (const event of observation.events) if (!accumulator.consume(event)) break;
  return accumulator.result(observation, final, observation.has_more || accumulator.scanned < observation.events.length, observation.stream_lost, observation.facts_lost, observation.cursor_floor);
}
