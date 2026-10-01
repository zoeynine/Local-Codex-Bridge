#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.env.LOCAL_CODEX_BRIDGE_DAEMON_ENV_RECEIPT) writeFileSync(process.env.LOCAL_CODEX_BRIDGE_DAEMON_ENV_RECEIPT, JSON.stringify({ node_options: process.env.NODE_OPTIONS !== undefined, daemon_directory: process.env.LCB_DAEMON_ATTEST_DIR !== undefined, daemon_hook: process.env.LCB_DAEMON_ATTEST_HOOK !== undefined, proof_config: process.env.LCB_RUNTIME_PROOF_CONFIG !== undefined }), { mode: 0o600 });
await import('./fake-codex.mjs');
