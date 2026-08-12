# AI Agent Guidance

## Project intent

This `macos` branch is the long-lived macOS implementation of Local Codex Bridge V2.1.2. It belongs to the same GitHub project as the Windows implementation on `origin/main` and must preserve the same seven-tool contract, functional semantics, and core supervision boundaries. Source, tests, launchers, and runtime details are platform-owned and need not share an implementation or commit hash.

Keep the Bridge thin. Its purpose is to let ChatGPT or another MCP client supervise official Codex threads without creating a second task system, transcript store, queue, retry loop, or authority layer. Native Codex owns persistent threads, turns, history, final messages, and execution capabilities. Bridge-owned state is limited to bounded live supervision data, pending requests, terminal snapshots, and optional bounded checkpoints.

When syncing a newer functional version from `origin/main`, analyze the changed public behavior first, implement the equivalent semantics natively on macOS, run macOS acceptance, and only then advance this branch's version. Synchronize functionality, not unnecessary platform code. Do not reintroduce code, launch assets, runtime helpers, fixtures, or test dispatch that exist only for another operating system.

If macOS work reveals a genuinely platform-independent bug, isolate only the smallest general fix for separate review on Windows `main`; never merge the complete macOS platform implementation back into `main`.

## Architecture

The runtime chain is:

```text
MCP client -> Local Codex Bridge (JSON-RPC stdio)
           -> official `codex app-server --listen stdio://` (JSONL stdio)
           -> native Codex sessions
```

`src/mcp.ts` owns the MCP boundary, `src/app-server.ts` owns the official child-process protocol, `src/tools.ts` owns the public tool contract, and `src/runtime.ts` owns ephemeral live state. `src/checkpoint.ts` provides the separate optional local checkpoint store. Secure MCP Tunnel is an optional external transport layer. Bridge implements stdio MCP only and does not expose an HTTP MCP endpoint.

The seven public tools have distinct semantics:

- `codex_threads`: list/search/read persistent native threads; filters are not access control.
- `codex_turn`: create or resume a native thread and start a turn; acceptance is not completion.
- `codex_observe`: read bounded live state or explicitly degraded persisted history after Bridge state loss.
- `codex_steer`: append a semantic correction to the exact active turn; do not use it as a timer or retry.
- `codex_respond`: answer one real pending app-server request using its raw ID and exact scope.
- `codex_interrupt`: interrupt one exact native turn; it is not process control.
- `codex_checkpoint`: maintain optional bounded supervisor cognition metadata; it is not a transcript or lifecycle database.

Preserve these distinctions, tool names, validation, annotations, schema limits, and stdout protocol purity unless a requested contract change explicitly requires otherwise.

## macOS platform boundaries

This branch requires Node.js 24+ and the official Codex executable. Resolve Codex from the target Mac's `PATH` or an explicit `CODEX_EXE`; do not add an npm Codex runtime dependency. A ChatGPT-bundled executable may exist under `/Applications/ChatGPT.app/Contents/Resources/codex`, but verify the actual machine instead of assuming that path.

New-thread working directories must be absolute POSIX paths. Preserve platform-independent validation such as type, length, NUL, and scope checks, but do not retain path syntax or runtime branches solely for another operating system. Relative paths and shell abbreviations such as `~` are outside the contract.

Checkpoint directory precedence is exact and explicit:

1. `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR`, when set to an absolute path.
2. `LUMEN_CODEX_V2_CHECKPOINT_DIR`, the explicit legacy alias, when the canonical variable is unset.
3. `~/Library/Application Support/LocalCodexBridge/checkpoints`.

Do not add automatic directory fallback, migration, or deletion. Keep checkpoints separate from native Codex history and bounded to supervisor cognition metadata.

For a strict MCP stdio client or Tunnel, execute `dist/src/index.js` with Node directly. `npm start` is suitable for an interactive terminal, but npm lifecycle output can corrupt a strict stdout protocol stream. Tunnel installation, authentication, profiles, ports, readiness endpoints, and process lifecycle are external configuration; never bake machine-specific values into the repository.

For an in-place production upgrade, preserve the existing Tunnel remote identity, canonical profile, and ChatGPT-facing connection. Change only the local MCP command and minimal environment, and do not create a second Tunnel. Tool names or contracts may evolve when the accepted functional version requires it; refreshing the ChatGPT app is allowed so the unchanged Tunnel entry can rediscover and initialize the declared contract.

The optional Finder launcher and Keychain workflow are implemented as a thin convenience around the current V2.1.2 runtime. The app bundle must resolve the adjacent repository launcher dynamically, remain free of author-specific paths, and invoke only the canonical production profile. The launcher may reuse one current-user generic-password item for the Tunnel runtime key, but the key must reach only `tunnel-client`; the profile must remove `CONTROL_PLANE_API_KEY` before Bridge, and Bridge must remove it again before Codex. Keep this workflow lightweight: no LaunchAgent, daemon, menu-bar app, browser UI, copied credential, or second Tunnel identity. Revalidate the app bundle, exact duplicate guard, no-prompt Keychain reuse, and real Finder cold start on the target Mac before claiming it works there.

## Security and permission boundaries

The Bridge is not an OS sandbox and must not claim to be one. Codex permissions come from the official runtime plus the selected sandbox and approval policy. Prompts constrain intended behavior; they do not reduce native process capability by themselves.

Treat native thread visibility, the Bridge process environment, and the local macOS user as trust boundaries. The app-server child inherits a deliberately filtered Bridge environment. `CONTROL_PLANE_API_KEY` belongs to the Tunnel control plane: production commands should remove it before starting Bridge with `env -u CONTROL_PLANE_API_KEY`, and Bridge must defensively remove it before spawning Codex. Never write secret values to fixtures, logs, examples, profiles, repository files, or argv.

Never fabricate approval or user-input request IDs. A response must match an actually pending request's ID, thread, method, and turn scope. Do not silently turn `cwd` filters into security claims. Avoid stdout diagnostics because stdout is reserved for MCP JSON-RPC; operational diagnostics belong on stderr and still require redaction.

Do not modify a user's Codex installation, Tunnel authentication/profile, unrelated services, or system permissions unless the user explicitly places them in scope. Live smoke tests create persistent native threads and therefore require deliberate authorization.

## Adapting to another Mac

Inspect the current checkout and target machine before deciding how to install or run it. Do not copy maintainer-specific paths, credentials, profiles, ports, PIDs, readiness URLs, or executable locations. Prefer evidence from current source, tests, package metadata, and the actual machine over old deployment state.

Use the `macos` branch when cloning or deploying this implementation. Build before configuring a production client, and make the direct Node execution of `dist/src/index.js` the production target. Do not claim another operating system is supported by this branch without a separate implementation and real validation.

## Acceptance expectations

A rebuild or installation should demonstrate, as applicable:

- `npm ci`, type checking, build, and the macOS automated test suite succeed;
- the MCP server keeps stdout clean, initializes correctly, and exposes exactly the seven intended tools;
- the official Codex executable is resolved and launched as `app-server --listen stdio://`;
- absolute POSIX `cwd` validation and the macOS checkpoint default and explicit environment precedence are verified;
- the Tunnel production target is the direct Node execution of `dist/src/index.js`;
- `CONTROL_PLANE_API_KEY` is absent from the Codex child environment, with upstream removal recommended as the first boundary;
- persistent native history and ephemeral Bridge state remain clearly separated;
- no author-specific path, credential, profile, port, PID, or secret enters tracked files;
- optional Tunnel behavior is validated only when requested, against the exact target-machine configuration;
- live Codex smoke testing uses read-only macOS commands and is reported separately from deterministic tests, including its persistent-thread side effect.
- stdin EOF and SIGINT shutdown reap the exact Bridge-owned app-server child without leaving an orphan process.
- the signed Finder bundle resolves its repository-relative launcher, a repeated ready-state double-click does not create a second production tree, and the existing Keychain item supports a no-prompt cold start without leaking its value.

Use these as outcome criteria, not as a fixed command-by-command procedure. Preserve the trust boundaries and report observed evidence and remaining limitations precisely.
