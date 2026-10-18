# AI Agent Guidance

## Local maintenance boundaries

本仓库是唯一维护源码；生产安装、凭据、用户历史和事故原始目录不属于常规开发写入范围。
默认单写者；不 reset、clean、stash 共享工作区。新能力先记录 find-wheel Phase 1。
候选、local validation、release、installed、runtime effective、production accepted 必须分别报告。
不得自动重放 mutation，不提高 10 MiB JSONL 上限以掩盖事故，不记录历史正文或巨大协议正文。
发布须 typecheck + 隔离自动测试 + 清洁解包构建测试 + 包外冻结信任锚点；独立复核与明确授权后才部署。
正常服务重启仅允许精确 `gui/<uid>/com.openai.tunnel-client.lcb-remote` 的 kickstart；禁止 broad kill、bootout/bootstrap 和终止 Desktop。
部署必须核对生产/host 基线、完整备份、manifest allowlist、原子 dist 替换；失败恢复文件并证明旧实例已加载，否则 MANUAL_RECOVERY_REQUIRED。
外层健康 200 不算内部 Bridge 或真实远程路由成功；不以直接 Responses API 验收 Bridge。

**Release contract: V2.3.4**

The local source candidate is V2.3.4-local.1; installed candidate.10 remains V2.1.3-local.1. Source integration does not authorize deployment. The local `latest_messages` extension remains a bounded, explicitly degraded compatibility view; use `codex_history` for native persisted history.

This file is guidance for AI agents working on Local Codex Bridge. It is not a product overview and should not be treated as a substitute for the source, tests, or protocol qualification notes.

Read the current repository state before acting. Prefer current source and tests over remembered behavior, old issue context, or assumptions about Codex internals.

## Project intent

Local Codex Bridge is a thin MCP stdio supervisory surface for native Codex, with one shared Windows/macOS core and optional platform-specific integration layers.

Its purpose is to let ChatGPT or another MCP client supervise native Codex work without creating a second task system, history store, queue, retry loop, semantic index, model registry, or lifecycle authority.

Keep the Bridge thin.

Native Codex owns persistent threads, turns, execution, history, Goal, Queue, Search, model state, sandbox behavior, and approval behavior. Bridge-owned state is limited to bounded live supervision state, pending requests, terminal snapshots, optional bounded checkpoints, and narrow compatibility / UX projection where explicitly implemented.

Do not solve an upstream capability gap by casually inventing a parallel Bridge subsystem.

## Runtime architecture

The core chain is:

```text
MCP client
   -> Local Codex Bridge (MCP JSON-RPC over stdio)
   -> official `codex app-server --listen stdio://` (JSONL stdio)
   -> native Codex threads / turns
```

Primary ownership in the repository:

- `src/mcp.ts` — MCP transport boundary and result framing
- `src/app-server.ts` — official Codex app-server child process and protocol requests
- `src/tools.ts` — public MCP tool schema and supervisory contract
- `src/runtime.ts` — bounded ephemeral live state, pending requests, terminal snapshots
- `src/observe-compact.ts` — compact typed supervision projection
- `src/history.ts` — lossless History delivery checks
- `src/goal.ts` — Native Goal validation / delivery
- `src/queue.ts` — Native Queue validation / delivery
- `src/search.ts` — Native Search validation / delivery
- `src/checkpoint.ts` — optional bounded supervisor checkpoint
- `src/platform.ts` — Windows/macOS platform boundary
- `src/version.ts` — canonical Bridge version
- `PROTOCOL-ASSUMPTIONS.md` — version-sensitive upstream contract and revalidation notes

The Windows Tray, macOS launcher surfaces, and Secure MCP Tunnel integration are outer layers. They are not alternate Bridge runtimes.

## V2.3.4 public surface

V2.3.4 exposes exactly twelve public MCP tools. Preserve their distinctions unless a requested contract change explicitly requires otherwise.

- `codex_threads` — list/filter/read native persisted thread metadata and capability/lineage facts. Filters are not ACLs and capability metadata is not a Bridge writer-lease model.
- `codex_history` — page native persisted history. Do not create Bridge history state, synthetic cursors, or automatic full-history fallback.
- `codex_search` — expose native thread search and within-thread occurrence locators. Do not add a Bridge semantic index, relevance scorer, workspace inference layer, or full-history fallback.
- `codex_models` — read one bounded current native model page. Do not cache a model registry or reconstruct a current-model state.
- `codex_goal` — map native thread Goal get/set/clear. Bridge sends no additional resume or turn-start request for these operations, but active goals may still cause native execution. Do not merge Goal with checkpoints or infer that Goal clear interrupts or blocks already-scheduled execution.
- `codex_queue` — map native queued follow-up list/add/update/delete/reorder. Do not add a Bridge scheduler, queue store, retry loop, or implicit queue start.
- `codex_turn` — create or resume a native thread and start one turn. Acceptance is not completion.
- `codex_observe` — read bounded live supervision state, or explicit unavailable-live placeholders after Bridge runtime loss. Persistent recovery belongs to History.
- `codex_steer` — add semantic correction to the exact active turn. Do not use it as a timer, liveness probe, retry mechanism, or periodic nudge.
- `codex_respond` — answer one real pending app-server request using the original typed request id and exact thread/method/turn scope.
- `codex_interrupt` — interrupt one exact native active turn. It is not process control and does not restart Bridge or app-server.
- `codex_checkpoint` — maintain optional bounded supervisor cognition metadata. It is not a transcript, job record, native history replacement, or lifecycle database.

If a new upstream API exists, its existence alone is not a reason to expose it.

## Core semantic invariants

### Terminal state is status-first

Always interpret a terminal using native `terminal.status` first.

Do not infer terminal classification from the presence or absence of other fields.

In particular:

- `final_result` may exist on a non-successful terminal, including interrupted work;
- `terminal.error` does not imply `status:"failed"`;
- an interrupted turn may carry a structured error;
- Bridge must not depend on a separate error notification to discover a terminal reason.

Preserve `status`, `final_result`, and `error` as distinct facts.

If protocol changes introduce new terminal combinations, add a targeted deterministic regression before changing projection semantics.

### Live state and persistent history are separate domains

`codex_observe` is live supervision. `codex_history` is native persisted content.

After Bridge runtime loss:

- do not reconstruct active-turn state from persisted turns;
- do not claim an empty pending set unless live runtime actually provides that fact;
- do not synthesize a live cursor from History;
- do not treat stored metadata as proof of current writer ownership or current activity.

When `runtime_available:false`, unavailable live fields are unknown even if transport placeholders are present.

When `runtime_available:true`, compact `pending_requests` is a full current snapshot; omission means the current pending set is empty.

### Goal, Queue, Steer, and Checkpoint are not interchangeable

Treat them as different native/supervisory concepts:

- Goal — persistent native thread objective
- Queue — native follow-up submissions after active work
- Steer — semantic correction to the current active turn
- Checkpoint — bounded Bridge-side supervisor anchor

Do not collapse these into a generic "next prompt" abstraction.

`codex_goal(action:"set")` requires explicit budget intent:

- `preserve` — omit native `tokenBudget`
- `unlimited` — send native `tokenBudget:null`
- `fixed` — require a positive JavaScript safe-integer `token_budget`

There is no Bridge default budget mode.

Bridge sends no additional resume or turn-start request merely because Goal get/set/clear is called. **Active goals may still cause native execution.** Clearing a Goal is not turn interruption and is not a barrier against execution that native Codex has already scheduled.

Queue delete is not turn interruption either. Use the exact interrupt surface when the current active turn must stop.

### Search locates; History reads

Do not turn `codex_search` into a content store.

Occurrence `turnCursor` may be used as a narrow History anchor for the same thread, but search continuation cursors, History cursors, thread-list cursors, and live numeric observe cursors are different domains.

Do not silently interchange them.

### Capability and lineage are metadata, not authority

Fields such as `canAcceptDirectInput`, `sessionId`, `forkedFromId`, `parentThreadId`, and source metadata are native facts.

Do not reinterpret them as:

- a cross-client writer lease;
- a permission cache;
- a resume requirement;
- a Bridge-owned relationship graph.

Parent/ancestor spawned lineage and fork lineage are different concepts.

## MCP result transport

All successful V2.3.4 tool calls return the full machine-readable result in:

```text
result.structuredContent
```

`result.content` contains only a tiny text marker and must not be treated as the success JSON payload.

Errors continue through explicit error / text paths.

Do not reintroduce duplicate success JSON in text content for convenience. Client migration belongs on the client side unless the public contract is deliberately revised.

## Mutation uncertainty

A mutating request can be written to native app-server and then time out before acknowledgement.

For affected operations, this means:

**UNKNOWN / possibly accepted**

It does not mean failure.

This includes, as applicable:

- thread start / resume
- turn start / steer / interrupt
- Goal set / clear
- Queue add / update / delete / reorder

Do not automatically retry an UNKNOWN mutation.

First inspect native state using the appropriate observation/read surface, then decide whether any further mutation is safe.

Keep acknowledgement timeout distinct from:

- a confirmed native rejection;
- a confirmed native success whose response body could not be delivered losslessly.

Do not add automatic compensation unless the upstream contract supplies a safe, tested idempotency guarantee and the public Bridge contract is deliberately changed.

## Compact observation rules

Compact exists to reduce supervision noise, not to make semantic judgments for the supervisor.

It may mechanically:

- project recognized native events into bounded typed facts;
- coalesce allowed lifecycle noise;
- drain retained events in bounded chunks;
- wake on supported structural conditions.

It must not decide:

- importance;
- relevance;
- correctness;
- progress quality;
- risk;
- whether Codex is stalled.

A lack of command output is not proof of a stall.

Use `next_cursor` for continuation.

Preserve the distinction between:

- `stream_lost` — dropped allowlisted streaming delta evidence
- `facts_lost` — dropped non-stream supervision evidence
- `cursor_lost` — aggregate loss indicator

Do not jump to `cursor_floor` as a substitute for cursor continuation.

Unknown or structurally incompatible native events should remain visible as bounded diagnostic evidence rather than being guessed into a known semantic type.

## History and lossless delivery

History is intentionally stricter than ordinary metadata projection.

A successful History page must remain lossless within the documented transport boundary.

Do not:

- return partial History data with a cursor after lossless validation fails;
- redact/truncate a page and still call it success;
- create Bridge item/chunk cursors;
- fall back to a full thread hydration;
- rebuild live state from History.

Paginated and legacy history modes have different native shapes. Preserve that distinction.

Default protected History/Search reads may reject secret-shaped content. Explicit per-call exact reads may expose sensitive native content; the choice is not an access-control or trust level. Goal/Queue exact responses and observe/diagnostic redaction have separate responsibilities.

Exact paging, byte-budget, content-policy, and cursor rules belong in `PROTOCOL-ASSUMPTIONS.md` and the relevant tests; do not duplicate drifting low-level constants into new policy code unless needed.

## Server requests and approvals

Never fabricate request IDs.

A `codex_respond` operation must match an actually pending supported request using:

- the original typed request id;
- the exact request method;
- the exact thread scope;
- the exact turn scope where applicable.

Validate request-specific response shapes and mutually exclusive fields before claim whenever that information is available from the caller input. Some scope-completeness checks can only be finalized against the claimed pending request; if such a check fails, release the claim immediately and fail **before any native response write**. Do not describe this more strongly as “all validation is pre-claim.”

If a response write fails, preserve/release state so the same valid request remains answerable according to the current runtime contract.

Unsupported elicitation remains observable and pending; do not invent a generic elicitation response schema.

## Repeated MCP initialization

A repeated valid MCP initialize handshake on the same stdio child is compatibility traffic, not a reason to erase live supervision state.

Do not clear active runtime, pending requests, or unrelated live state merely because the MCP client initializes again.

Initialization identity handling must remain separate from native thread writer ownership. Do not generalize this compatibility behavior into a multi-writer guarantee.

## Security and trust boundaries

The Bridge is not an OS sandbox.

Native Codex capabilities are governed by the official runtime and the chosen sandbox / approval policy.

Prompts express intended behavior; they do not reduce native OS capability by themselves.

Treat the following as trust boundaries:

- the local OS user;
- visible native Codex threads;
- the Bridge process environment;
- the exact pending server-request identity;
- the optional remote Tunnel configuration.

Do not:

- add secrets to fixtures, examples, logs, profiles, or command lines;
- claim `cwd` or search filters are access-control boundaries;
- assume sanitization makes the Bridge a hostile multi-tenant gateway;
- modify the user's Codex installation, Tunnel credentials/profile, unrelated services, or OS permissions unless explicitly in scope;
- print diagnostics to stdout, which is reserved for MCP JSON-RPC.

Operational diagnostics belong on stderr and still require redaction.

## Cross-platform behavior

The published V2.3.4 implementation supports Windows and macOS with one shared core.

Do not fork core semantics by platform unless the OS boundary actually requires it.

Platform-specific differences may include:

- executable/path resolution;
- launcher integration;
- checkpoint default directory;
- process spawning / termination details;
- optional Tray / Finder integration.

Use native path semantics for new thread working directories:

- Windows — absolute drive-letter path
- macOS — absolute POSIX path

Resolve official Codex from the target machine's `PATH` or explicit `CODEX_EXE`. Do not add an npm Codex runtime dependency.

For strict MCP stdio clients or Tunnel use, launch the built Node entry directly. Do not put `npm start` behind a strict JSON-RPC stdio transport because npm lifecycle output can contaminate stdout.

Never copy maintainer-specific paths, ports, PIDs, Tunnel profiles, readiness URLs, or credentials into generic configuration.

## Protocol-facing changes

Before changing behavior that depends on Codex app-server:

1. inspect the current installed/native schema or authoritative upstream contract;
2. read `PROTOCOL-ASSUMPTIONS.md`;
3. identify whether the change affects public semantics, only compatibility, or only optional diagnostics;
4. add or update the narrowest deterministic regression that locks the intended behavior;
5. use live qualification only when deterministic evidence cannot establish the required behavior;
6. keep version-specific observations distinct from stable public guarantees.

Do not promote an upstream main/prerelease behavior into the stable compatibility baseline merely because a watch or commit reports it.

A compatibility canary may lock that the current Bridge already behaves safely under a future-compatible shape without claiming that shape is now a required stable dependency.

## Scope discipline

Do not turn a targeted compatibility fix into an architectural expansion.

When a change is requested:

- identify the smallest affected public contract;
- keep unrelated surfaces unchanged;
- avoid speculative abstractions;
- do not add state because it may be useful later;
- do not expose another upstream API merely because it exists;
- do not "improve" native semantics by replacing them with Bridge policy.

If there is no real Bridge layer to delete or simplify, an upstream simplification opportunity can remain informational.

## Adapting to another machine

Inspect the current checkout and target environment before choosing commands.

Prefer evidence in this order:

1. current source and tests;
2. current package/version metadata;
3. actual target-machine behavior;
4. current protocol qualification notes;
5. older docs or historical assumptions.

If documentation and implementation disagree, establish source/test truth before changing either.

Do not claim a platform, native capability, or deployment path was validated unless it actually was.

Live Codex probes can create persistent native threads. Keep them separate from deterministic tests and run them only when their side effects are explicitly acceptable.

## Acceptance expectations

For a normal V2.3.4 code or deployment change, demonstrate the relevant subset of:

- dependency installation succeeds;
- type checking succeeds;
- build succeeds;
- regular automated tests succeed;
- `npm run check:compact-schema` succeeds against the intended official Codex executable when protocol-facing behavior is relevant;
- MCP stdout stays protocol-clean;
- initialization exposes exactly the intended twelve tools;
- native app-server launches with the intended stdio arguments;
- persistent History remains separate from ephemeral Bridge live state;
- no author-specific path, credential, Tunnel profile, port, or secret enters generic files;
- optional platform integration is tested only when changed or when the requested acceptance scope requires it;
- live Codex testing, if used, is reported separately with its persistent-thread side effect.

Do not repeat cross-platform live testing merely to fill a matrix when a later change is demonstrably test-only or platform-neutral and the agreed acceptance scope does not require it.

Report observed evidence, what was not tested, and whether runtime behavior changed.

## Release-facing documentation

README is the human-facing product and usage entry.

AGENTS.md is the engineering guidance for agents.

`PROTOCOL-ASSUMPTIONS.md` is the precise version-sensitive protocol qualification surface.

CHANGELOG records released engineering changes.

Do not make one file carry all four roles.

When public behavior changes, update the smallest set of documents that actually owns that information. Avoid copying unstable protocol detail into README or AGENTS when a durable invariant plus a pointer to `PROTOCOL-ASSUMPTIONS.md` is sufficient.
