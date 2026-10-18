# Local Codex Bridge

[English](README.md) · [简体中文](README.zh-CN.md)

本地正式维护项目的唯一源码源位于本仓库；安装目录仅承载经过批准的发布版本。
本次源码候选为 **V2.3.4-local.1**，合并 upstream V2.3.4；已安装且验收的 candidate.10 仍为 **V2.1.3-local.1**。本次只更新源码与 PR，未部署或重启生产。封存发布与历史验收证据保留原版本及原摘要。

上游提供 12 工具及独立 `codex_history` / Goal / Queue / Search。本地 `codex_threads(thread_id, latest_messages:1..100)` 保留为有界、可降级的兼容视图，不能替代独立 History 或重建 live state；`include_turns:true` 单独使用仍拒绝无界读取，只有带 `latest_messages` 时映射为 metadata + recent messages。

```text
本仓库源码 → 隔离测试/构建 → sealed release + 包外 trust verifier
  → 生产基线核对 → 备份 → manifest 文件替换 + dist 原子交换
  → 定向 kickstart → 实际模块加载证明 → MCP initialize / 当前候选工具契约
  → native app-server → codex_apps → local_codex_bridge.codex_models(limit=1)
```

开发要求 Node.js 24+：`npm ci --ignore-scripts`、`npm run typecheck`、`npm test`。
隔离验证：`node scripts/validate-fix.mjs --isolated --output .validation`。
发布：验证通过并提交源码后执行 `npm run package:local`；新目录不可覆盖。
`releases/<version>/package` 是封存包，`releases/trust/<version>/verify-package.mjs` 是包外冻结信任锚点。
信任锚点必须由可信渠道单独保存/复核，不能从待安装包提取或重新计算来接受篡改。
唯一正式首入口是 `NODE EXTERNAL_VERIFIER PACKAGE_ROOT --verify|--check|--deploy|--rollback CONTRACT`；该包外runner先封存校验整个包，再执行固定的包内模块。不要直接执行包内shell或JS作为可信安装入口。
发布包含源码和 dist，不含 node_modules；干净解包后可 `npm ci --ignore-scripts && npm test`。
安装/回滚的显式配置、授权边界和异常恢复详见 [运维手册](ops/runbooks/operations.md)。
外层 healthz/readyz=200 只能证明 Tunnel 层；完整健康还需要控制面轮询、MCP、真实远程只读调用和实际加载证明。
事故机制和未知触发 RPC 详见 [事故报告](incidents/2026-09-28-jsonl-overflow/README.md)。

*A thin supervisory MCP bridge between external AI supervisors and native Codex.*

**Current release: V2.3.4-local.1** (source candidate; upstream release V2.3.4, installed candidate.10 V2.1.3-local.1)

Local Codex Bridge is a lightweight MCP stdio adapter for Windows and macOS:

```text
ChatGPT / external AI supervisor
              ↕
        Local Codex Bridge
              ↕
      native Codex app-server
              ↕
   native Codex threads / turns
```

It lets an AI that is good at conversation, planning, and sustained supervision oversee real engineering work performed by local native Codex. It does not recreate Codex.

**The supervisor owns the goal, resources, boundaries, risks, approvals, and acceptance. Codex retains its native autonomy for coding and execution.**

The Bridge stays thin:

- It creates no second job or task system.
- It does not copy Codex conversation history.
- It keeps no parallel thread database.
- It does not cache the “current model.”
- It does not rebuild Goal, Queue, or Search.
- It does not replace Codex session, thread, or turn semantics.

**The native Codex thread/session remains the source of truth for execution.**

[Changelog](CHANGELOG.md) · [Protocol and compatibility assumptions](PROTOCOL-ASSUMPTIONS.md)

---

## What V2.3.0 introduced

V2.3.0 expanded the public supervisory surface to **12 MCP tools** while retaining the boundary of exposing only the native surface needed for supervision.

The release added or refined:

- Independent paging of native persistent History.
- Native Goal: read, set, and clear a persistent objective.
- Native Queue: manage follow-up input for an active workflow.
- Native Search: search across threads and locate occurrences within a thread.
- On-demand capability and lineage metadata.
- Typed compact observation, drainage, and loss semantics.
- A single event-driven observe wait of up to 120 seconds.
- Delivery of every successful tool result through `structuredContent`.
- One shared Bridge core for Windows and macOS, with differences confined to native platform boundaries.

Bridge does not reimplement these capabilities. Native Codex still owns History, Goal, Queue, Search, and the thread lifecycle; Bridge provides bounded mappings and supervision.

---

## Responsibilities

### External supervisor / ChatGPT

The supervisor is suited to:

- Understand the user's goal.
- Break down the work.
- Set scope, resources, and risk boundaries.
- Decide when to keep observing, correct, approve, or interrupt.
- Judge whether the result meets acceptance criteria.
- Provide oversight when Codex cannot safely decide on its own.

### Native Codex

Native Codex continues to own:

- Thread and turn lifecycles.
- Workspace files and command execution.
- Its context and persistent history.
- Sandbox and approval-policy behavior.
- The actual model and reasoning effort in use.
- Persisted execution results.
- Native Goal, Queue, Search, and lineage.

### Local Codex Bridge

Bridge connects the two:

- MCP stdio ↔ Codex app-server JSONL.
- Bounded exposure of state needed for supervision.
- Forwarding explicit control intent.
- Failing closed at high-risk, ambiguous, or protocol boundaries.
- No second orchestration runtime.

---

## The 12 MCP tools

| Tool | Purpose | Main boundary |
| --- | --- | --- |
| `codex_threads` | List, filter, and read native persistent thread metadata | Metadata only; filters are not ACLs |
| `codex_history` | Page native persistent history | No Bridge history store or automatic full read |
| `codex_search` | Search native threads and locate within-thread occurrences | Returns locators; no Bridge index or relevance layer |
| `codex_models` | Read one native `model/list` page on demand | No cached catalog or current-model registry |
| `codex_goal` | Read, set, or clear a native thread goal | No implicit resume or turn start; distinct from checkpoint |
| `codex_queue` | Manage native queued follow-ups | No Bridge scheduler; enqueue does not mean execution or completion |
| `codex_turn` | Create or resume a thread and start a turn | Accepted does not mean completed |
| `codex_observe` | Read bounded live events, pending requests, terminal state, and cursor | Does not reconstruct live state after runtime loss |
| `codex_steer` | Add a semantic correction to the current active turn | Not a timer, poll, or retry |
| `codex_respond` | Answer a real pending approval, user-input, or permission request | Must match the original request ID and exact scope |
| `codex_interrupt` | Interrupt the exact active thread and turn | Not process control |
| `codex_checkpoint` | Keep an optional, concise, bounded supervisor anchor | Not a transcript, job ID, or Codex history |

See [`src/tools.ts`](src/tools.ts) for the full schemas and runtime validation.

### Content delivery and read policy

History and Search default to `content_policy:"protected"`. Secret-shaped content detection may reject an entire page, including ordinary code that matches the detector. A caller may explicitly choose `content_policy:"exact"` to deliver unchanged native text to the MCP caller for that call. This may expose sensitive content; it is not saved as a session preference and has no automatic fallback. Protected mode provides default detection and an explicit choice point, not an access boundary that prevents the supervisor from obtaining the original content.

Successful Goal and Queue reads and responses preserve native values without secret-shape filtering of their bodies. Known oversized echoed input is rejected before a write; native-added fields can still produce an acknowledged mutation whose result cannot be delivered. Do not resubmit the mutation for that reason. For an oversized multi-item page, a smaller limit may help. If one item remains oversized, inspect it on the native side; repeatedly making the same Bridge read cannot recover it. Errors and operational diagnostics remain redacted.

These exact responses do not inherit Observe's short-text, internal-array, or field-count budgets. They remain subject to actual byte limits, required-field checks, and defensive serialization checks. Failure never returns a partial page or fabricated cursor. See the [protocol details](PROTOCOL-ASSUMPTIONS.md#exact-content-delivery).

In compact view, `terminal.final_result_pending: true` means final text awaits a later page, and `final_result_meta` is omitted until then. Follow `next_cursor` even if the status is terminal. Once the text arrives, inspect `final_result_meta.complete`: `false` means source text was not fully received or live retention clipped it. Raw and terminal text also have a 48k cap. If more content is needed, read narrow History for that thread and terminal turn, or inspect native Codex. Ordinary compact-event budgets remain unchanged.

---

## Typical supervision workflow

### 1. Start or continue a turn

A successful `codex_turn` response only means native `turn/start` was accepted. It does not mean the task is complete.

Long-running work should usually continue under `codex_observe` supervision.

```text
codex_turn
    ↓
codex_observe
    ↓
 ┌───────────────┬────────────────┬─────────────────┐
 │ continue      │ steer          │ respond         │
 │ observing     │ same turn      │ real pending    │
 │               │                │ request         │
 └───────────────┴────────────────┴─────────────────┘
    ↓
terminal state / acceptance
```

Key rules:

- A long interval without new command output does not prove Codex is stalled.
- Use `codex_steer` for new semantic information or a correction, not a timed nudge.
- `codex_respond` can answer only a real pending request.
- Use `codex_interrupt` when the current turn actually needs to stop.
- `thread_id` is a native Codex thread identity, not a permanent task ID invented by Bridge.

### 2. Keep live state separate from persistent history

`codex_observe` serves current live supervision; `codex_history` reads native persisted turns and items.

After Bridge restarts, loses its runtime ring, or no longer has a live cursor, it does not manufacture a seemingly active runtime from history. Read `codex_history` to recover persistent content.

`codex_search` locates content; History reads it. An occurrence's `turnCursor` can anchor a narrow History read in the same thread, but Search does not replace History.

### 3. Keep Goal, Queue, and Steer distinct

- **Goal:** the persistent objective of a native thread.
- **Queue:** follow-up input that native Codex executes after the current active workflow.
- **Steer:** an immediate semantic correction to the current active turn.

These are not three spellings of a “next prompt,” and Bridge does not combine them into its own task model.

`codex_goal(action:"set")` requires an explicit budget intent:

| `budget_mode` | Native `tokenBudget` | Argument requirement |
| --- | --- | --- |
| `preserve` | Omitted, preserving the existing budget | Do not pass `token_budget` |
| `unlimited` | `null`, removing the budget ceiling | Do not pass `token_budget` |
| `fixed` | Specified amount | Pass a positive safe-integer `token_budget` |

Bridge sends no extra resume or turn-start request for Goal set, get, or clear. **An active Goal may still cause native Codex to continue execution.** Goal clear is not an interrupt or a barrier against work already scheduled. Use the exact `codex_interrupt` when the current turn must stop.

Queue delete likewise does not interrupt a turn that has already begun.

---

## `codex_observe`

The default `view:"compact"` delivers bounded, typed supervision facts. Use `view:"raw"` for a narrow inspection of retained native events.

Optional `wait_ms` performs one event-driven wait with a fixed deadline, up to `120000` ms. Bridge does not poll in the background or decide on its own that Codex is stalled.

Keep these distinctions in mind:

- Continue either view with `next_cursor`.
- `stream_lost` reports evicted streaming deltas.
- `facts_lost` reports evicted other supervision facts.
- `cursor_lost` summarizes either kind of loss; it does not tell you to jump to `cursor_floor`.
- With `runtime_available:false`, live pending, terminal, and cursor fields may only be unavailable placeholders. Do not infer that nothing happened.

When `runtime_available:true`, compact `pending_requests` is a complete current snapshot. Compact omits it when empty; absence means there are currently no pending requests, not that this page contains no update.

Compact `terminal.final_result` is also subject to the delivery window of the final item and terminal cursor. Final text may already have arrived as a message fact, so a compact terminal on one page may contain only `status` and `error`, without `final_result`. **An absent field does not mean the raw terminal snapshot or persisted History lacks final text.** Do not skip `next_cursor` or infer status just to force these fields onto one page.

---

## Terminal state: use `status`

**Always classify a terminal by native `terminal.status` first.**

Do not infer terminal status from other fields:

- `final_result` does not mean the turn succeeded.
- `terminal.error` does not necessarily mean `status:"failed"`.
- A turn with `status:"interrupted"` may carry a structured error.
- Bridge does not need a separate error notification to learn the terminal reason.

Read `terminal.status` first, then interpret `final_result` and `error` as separate facts about that terminal.

---

## Successful results use `structuredContent`

In V2.3.0, the complete result of every successful `tools/call` is in:

```text
result.structuredContent
```

`result.content` contains only a tiny text marker, not parseable success JSON.

Older clients that parse successful results from text content need to migrate to `structuredContent`.

Errors still use explicit `isError` and text-error paths; they are not disguised as successful results.

---

## Do not retry a write just because it timed out

If a native mutating request was written to app-server but its acknowledgement timed out, Bridge reports the outcome as:

**UNKNOWN / possibly accepted**

This is not a confirmed failure.

Affected requests include:

- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/goal/set` / `thread/goal/clear`
- `thread/queue/add` / `update` / `delete` / `reorder`

Observe or read native state first, then decide on any further action.

**Do not resubmit a mutating request solely because its acknowledgement timed out.**

Bridge does not automatically retry, compensate, or guess the result.

---

## History and Search

`codex_history` follows the native history mode:

- **Paginated thread:** page the turn index, then read items in a specified turn.
- **Legacy thread:** page complete turns.

Bridge creates no item/chunk cursors of its own and does not silently read a full history after a paging failure.

A successful History page must be delivered losslessly. A page that exceeds the transport byte boundary, triggers the selected content policy, or fails defensive JSON serialization is rejected in full. Bridge does not return partial data with a cursor.

`codex_search` maps native Search only:

- `kind:"threads"`: locators across threads.
- `kind:"occurrences"`: occurrence locators inside a specified paginated thread.

Search does not build a Bridge semantic index, score relevance, infer a workspace restriction, or fall back to reading complete History.

See [`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md) for exact paging, cursor, and transport contracts.

---

## Capability and lineage

`codex_threads` can expose native capability and lineage metadata on demand, including:

- `canAcceptDirectInput`
- `sessionId`
- `forkedFromId`
- `parentThreadId`
- Source information

These are native metadata, not a Bridge writer lease, permission model, or lifecycle database.

`parent_thread_id` and `ancestor_thread_id` can filter spawned descendants. Spawn lineage and fork lineage are different concepts. Bridge does not recursively build a relationship graph or automatically resume or take over a thread from lineage.

---

## Model and reasoning effort

Bridge does not take ownership of Codex's “current model” state.

If `codex_turn` omits `model` and `effort`, Bridge:

- Does not call `model/list`.
- Does not infer the current model.
- Does not send a new model or effort override.

If the supervisor specifies a model, Bridge performs bounded validation against the current native catalog. It does not cache the catalog or create a current-model registry.

Where upstream metadata cannot establish that a model and effort combination is incompatible, Bridge does not guess. Native Codex makes the final decision.

---

## Elicitation is currently unsupported

`mcpServer/elicitation/request` is not currently part of the response surface supported by `codex_respond`.

If native Codex emits such a request, Bridge:

- Retains and exposes it.
- Does not silently discard it.
- Does not guess its response schema.
- Does not fabricate a generic answer.

Support would require an explicit, stable, validated upstream contract.

---

## Quick start

### Requirements

- Windows or macOS
- Node.js 24+
- Official Codex executable:
  - Available as `codex` on `PATH`, or
  - Specified explicitly with `CODEX_EXE`.

This project does not bundle or depend on the `@openai/codex` npm package.

### Clone, build, and test

```bash
git clone https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

### Start directly

Windows PowerShell:

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # Omit if codex is on PATH
npm start
```

macOS / POSIX shell:

```bash
CODEX_EXE=/path/to/codex npm start
```

You may omit `CODEX_EXE` if `codex` is already on `PATH`.

### Configure an MCP client

A strict MCP stdio client should launch the built Node entry directly:

```text
command: node
args:    <absolute-path-to-repository>/dist/src/index.js
env:     CODEX_EXE=<optional-path-to-codex>
```

Client configuration formats vary, but the final command should run directly:

```text
node <repository>/dist/src/index.js
```

**Do not** put `npm start` behind Secure MCP Tunnel or another strict JSON-RPC stdio transport. npm lifecycle output can contaminate protocol stdout.

After the Bridge tool set changes, an already connected MCP client usually needs to reconnect or restart to refresh its tool catalog.

---

## Optional: Secure MCP Tunnel

Remote MCP use can place Secure MCP Tunnel in front of Bridge:

```text
remote MCP client
        ↕
Secure MCP Tunnel
        ↕
node <repository>/dist/src/index.js
        ↕
native Codex
```

Tunnel authentication, profile, port, readiness endpoint, and process lifecycle are external configuration.

This repository:

- Does not create a Tunnel profile.
- Does not store production credentials.
- Does not hard-code a production port.
- Does not turn the Tunnel control plane into a Bridge HTTP API.

---

## Windows

The optional Tray in `windows/` is a lightweight launch and status layer for an installed Tunnel client. It is not required for the Bridge core.

The canonical launcher is `LocalCodexBridgeTray.*`.

Local settings template:

[`windows/local-settings.example.json`](windows/local-settings.example.json)

The actual `windows/local-settings.json` remains ignored and is not committed.

Configuration precedence:

1. Explicit command-line arguments.
2. `LOCAL_CODEX_BRIDGE_*` environment variables.
3. Legacy `LUMEN_CODEX_V2_*` environment variables.
4. Ignored local settings.

The Tray does not restart Tunnel automatically. It stops a process started by the current Tray instance only after rechecking that process identity, profile, PID, and related information still match.

---

## macOS

`Start Mac Codex Bridge.app`, `launcher/`, and `bin/start-production-tunnel` provide macOS Finder and Tunnel integration.

They are platform layers. The Bridge still runs the same entry:

```text
dist/src/index.js
```

After changing the launcher or Finder bundle, rebuild and validate on macOS 12+:

```bash
launcher/build-launcher.sh
npm run test:macos
```

Windows and macOS are two platform entry points to one Bridge, not separate implementations.

---

## Security and trust boundaries

Local Codex Bridge **does not create a new operating-system sandbox**.

Actual file, command, network, and process capabilities still depend on native Codex configuration and each turn's:

- `sandbox`
- `approval_policy`

For example:

- `danger-full-access` broadens the file, command, and process access allowed by the sandbox.
- `approval_policy=never` does not expand the OS sandbox by itself, but removes the interactive approval layer.

These are separate risk dimensions.

Also keep in mind:

- Natural-language instructions sent through `codex_turn` or `codex_steer` may lead Codex to use its existing file and command capabilities.
- The absence of a generic shell MCP tool in Bridge does not mean native Codex cannot execute commands.
- `codex_threads` can see persistent threads visible to the same OS user and Codex runtime. Filters do not provide access isolation.
- Bridge inherits its environment when starting app-server, except that it removes the Tunnel `CONTROL_PLANE_API_KEY`.
- Other environment variables remain part of the trusted launch boundary; avoid unnecessary secrets there.
- Bridge has transport sanitization and bounded projection, but is not a hostile multi-tenant gateway.
- Keep checkpoints short; do not store full prompts, transcripts, raw events, command output, or final answers.

For remote use, an authenticated and correctly configured Tunnel must provide the connection boundary.

---

## Persistence

Native Codex persists:

- Threads.
- Turns.
- Conversation history.
- Native execution results.
- Thread goals.
- Queued follow-ups.

Bridge's live event ring, active-turn runtime state, and pending requests are primarily bounded in-memory state.

After ring loss, Bridge does not reconstruct fake live state from History. `stream_lost`, `facts_lost`, and `cursor_lost` explicitly report missing live supervision evidence.

### Checkpoint

`codex_checkpoint` is the one intentionally persisted piece of Bridge-side supervisory state, and it remains concise and bounded.

Windows default:

```text
%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json
```

macOS default:

```text
~/Library/Application Support/LocalCodexBridge/checkpoints/<sha256(thread_id)>.json
```

Override with:

```text
LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR
```

The legacy `LUMEN_CODEX_V2_CHECKPOINT_DIR` is still supported for compatibility. Bridge does not automatically migrate old checkpoints.

---

## Deliberate non-goals

Local Codex Bridge deliberately does not provide:

- A browser UI.
- An HTTP control plane or HTTP MCP server.
- A second task queue or job database.
- Transcript duplication.
- A semantic index.
- A model cache or current-model registry.
- A queued-message facade.
- Automatic retries of mutating requests.
- Automatic app-server restart.
- A generic shell or `command/exec` MCP surface.
- Automatic exposure of every experimental app-server API.

The aim is not to copy all of Codex app-server into MCP, but to expose the smallest validated surface needed for supervision.

---

## Upgrading Codex

Bridge necessarily depends on a small set of native app-server protocol assumptions.

Current dependencies, validation status, corresponding code locations, and checks needed after upstream changes are collected in:

[`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md)

When upgrading the Codex runtime, changing protocol-facing behavior, or investigating a related regression, check that list first. Do not change Bridge solely on the basis of an older implementation assumption.

---

## Development and testing

Common checks:

```bash
npm run typecheck
npm run build
npm test
```

`npm test` runs shared runtime, compact, History, Goal, Queue, Search, app-server, MCP, checkpoint, platform, shutdown, UX, and related tests, then the tests for the current platform.

The protocol/compact-schema check requires `CODEX_EXE` to explicitly identify the official Codex executable under test. This script does not use the `PATH` fallback of the normal Bridge startup path.

Windows PowerShell:

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe'
npm run check:compact-schema
```

macOS / POSIX shell:

```bash
CODEX_EXE=/path/to/codex npm run check:compact-schema
```

The repository retains the historical `npm run smoke:live` helper, but **the current script has not been adapted to V2.3.0 `structuredContent`, independent History, or the runtime-loss contract. It is not a valid smoke or cross-platform acceptance command for this release.** Do not run it merely to qualify a release. If a live smoke test is needed later, update the script separately and review its persistent-thread side effects first.

Main implementation locations:

- `src/mcp.ts` — MCP stdio / JSON-RPC boundary
- `src/app-server.ts` — native Codex app-server process / protocol adapter
- `src/tools.ts` — 12 tools, schemas, and supervisory semantics
- `src/runtime.ts` — bounded live runtime / events / pending requests
- `src/observe-compact.ts` — compact typed supervision projection
- `src/history.ts` — lossless History delivery checks
- `src/goal.ts` — native Goal validation / delivery
- `src/queue.ts` — native Queue validation / delivery
- `src/search.ts` — native Search validation / delivery
- `src/checkpoint.ts` — optional supervisory checkpoint
- `src/platform.ts` — Windows / macOS platform boundary
- `src/version.ts` — canonical Bridge version
- `windows/` — optional Windows Tray
- `launcher/`, `bin/`, `Start Mac Codex Bridge.app` — optional macOS integration

---

## License

MIT License — see [`LICENSE`](LICENSE).

## Collaborators and acknowledgements

Collaborators: **Xiaonian (ChatGPT)** and **Alden / Xingjian (Codex)**.

Thank you for helping turn the small idea of letting an external AI genuinely supervise native Codex, step by step, into a Bridge thin enough and clear enough to share and build on. `(*╹▽╹*)`

And thank you to **Yu'an**. Without you, I would not have tried to do something at all. ღ( ´･ᴗ･` )
