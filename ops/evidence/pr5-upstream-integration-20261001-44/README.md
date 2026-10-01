# PR #5 upstream V2.3.4 integration

Task: `LCB-PR5-CONFLICT-RESOLUTION-44`. Validation recorded at 2026-10-01T03:01:31Z. This is source integration evidence, not release sealing, deployment, runtime acceptance, or independent review.

## Frozen inputs and scope

- Clean source branch: `local/2.1.3-local.1`, initial HEAD `19d6218d832704c64a5209322f3b0e9d4c24a8b1`.
- Upstream: `edfb3a584cc1dc6ee9faea3016b93510f2913542`, V2.3.4. Both remote refs were read back unchanged before commit.
- Ordinary `git merge --no-commit --no-ff upstream/main`, followed by explicit semantic resolution of nine files. No reset, stash, clean, force push, or whole-file ours/theirs resolution.
- Source candidate: `2.3.4-local.1`. Installed and previously accepted candidate.10 remains `2.1.3-local.1`; no production installation, credentials, persistent native sessions, service settings, or daemon restart were touched by this task.
- Existing `releases/`, `ops/evidence/`, and `incidents/` bytes were unchanged before adding this new integration evidence directory. Historical acceptance does not qualify this source candidate for deployment.

## Conflict decisions

| Path | Resolution |
| --- | --- |
| `AGENTS.md` | Retain all local maintenance/deployment boundaries, integrate upstream V2.3.4 architecture and twelve-tool rules, explicitly document the local bounded compatibility extension. |
| `CHANGELOG.md` | Keep both version histories and original historical candidate statements; add a source-only V2.3.4-local.1 entry and current installed/source distinction. |
| `README.md` | Retain local maintenance/runbook/trust/incident guidance, combine with upstream English README; clarify source candidate, installed candidate.10, twelve-tool surface, and `latest_messages` extension. Chinese README receives matching version/boundary text. |
| `package.json` | Set source candidate version; union all local and upstream shared tests; preserve local packager and upstream compact-schema qualification script. No dependency change. |
| `package-lock.json` | Synchronize both root version fields with package version; preserve dependency lock bytes. |
| `src/tools.ts` | Keep upstream History/Goal/Queue/Search/compact contracts and lineage filters. Keep local metadata identity validation, bounded `latest_messages` paging, and explicit history degradation. Reject unbounded `include_turns:true` before RPC. Observe preserves upstream unknown-live placeholders, stripped persisted turns, and metadata source, plus local compatibility diagnostics. |
| `src/version.ts` | Canonical source V2.3.4-local.1; launcher version V2.3.4 separately reflects byte-for-byte upstream signed launcher files. |
| `test/mcp.test.ts` | Preserve upstream twelve-tool/structuredContent/method-discovery tests and local tests; combine import. |
| `test/tools.test.ts` | Preserve both bounded local history regressions and upstream `excludeTurns:true` resume regressions. |

## Necessary integration repairs

First whole-suite run found three failures (393 pass, 3 fail, 2 Windows skips). The upstream overflow test assumed fatal state forbids a fresh metadata read, while the local branch intentionally permits one new explicit safe-read recovery. The test now proves mutation remains rejected after overflow, then verifies exactly that safe-read recovery; no failed call is replayed.

The source daemon module inventory originally contained nine modules and rejected new upstream runtime imports during isolated startup. The explicit source allowlist now contains the exact nineteen loaded runtime modules. Existing missing/extra/hash/nonce/process identity checks remain; isolated daemon tests verify the complete exact loaded inventory, immutable in-memory hashes after disk modification, and twelve public MCP tools. Sealed historical hooks and inventories remain untouched. This change does not authorize upgrading production hooks.

The existing remote model probe already supports `structuredContent`; source probe behavior is unchanged. Two additional deterministic scenarios verify structured success and invalid structured data alongside legacy JSON-as-text scenarios.

## Verification

The default shell Node was V22.21.1, below the declared Node 24+ engine. All build/test commands used the existing `/opt/homebrew/opt/node@26/bin` runtime, V26.3.1, without changing system defaults or production runtime.

- `npm run typecheck`: PASS (initial resolution and final source).
- Focused build and `node --test dist/test/app-server.test.js dist/test/daemon-attestation.test.js dist/test/remote-probe.test.js`: 90 tests, 90 pass, 0 fail.
- Final `npm test`: build PASS; shared 400 tests, 398 pass, 0 fail, 2 Windows-specific skips; macOS 5 tests, 5 pass, 0 fail.
- `git diff --check`: PASS; no conflict markers remain in the nine resolved files.
- Existing release/evidence/incident trees: no changed historical path.

Unverified: Windows runtime, installed Codex schema currentness, production twelve-tool behavior, live native/remote smoke, clean-unpack/sealed candidate construction, deployment/rollback, and independent review. No live persistent-thread smoke was run. `scripts/validate-fix.mjs` remains historical overflow validation and was not invoked against the new baseline. This task does not claim new release/deployment readiness from the retained historical bootstrap/manifest tooling.

## Phase 1 reuse and routing record

Before conflict edits, reviewed existing local controls and upstream V2.3.4 implementation plus the [Git merge documentation](https://git-scm.com/docs/git-merge) (Git V2.54.0, read 2026-10-01 UTC). Chosen approach: adapt existing three-way merge and both existing implementations/test suites. It directly fits the bounded integration goal; no new merge framework, service, dependency, or parallel lifecycle system is useful here. Native Git and explicit local inventory checks suffice, so no research phase is needed.

Development cost: bounded conflict review, exact module inventory adaptation, and deterministic regression verification. Deployment cost: none in this source-only task. Growth cost: maintain compatibility extension and exact inventory alongside upstream changes; no new per-user service or vendor dependence. Actual elapsed/cost/token usage: unknown. No cost-saving claim.

`conflict integration | difficult / requested gpt-6.1-sol / high | cross-version semantic conflicts and runtime attestation integration | one merge attempt, one initial full-suite failure followed by focused repair and passing final suite | local validation PASS; independent acceptance pending | effective model and usage unknown; unverified items listed above`
