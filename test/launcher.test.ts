import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const launcher = join(repositoryRoot, "bin", "start-production-tunnel");
const launcherSource = join(repositoryRoot, "launcher", "StartMacCodexBridge.c");
const launcherBinary = join(
  repositoryRoot,
  "Start Mac Codex Bridge.app",
  "Contents",
  "MacOS",
  "StartMacCodexBridge",
);
const launcherBundle = join(repositoryRoot, "Start Mac Codex Bridge.app");

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return code;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(processExists(pid), false, `process ${pid} did not exit`);
}

test("Finder launcher sources do not contain author-specific executable paths", () => {
  const shellSource = readFileSync(launcher, "utf8");
  const cSource = readFileSync(launcherSource, "utf8");
  assert.doesNotMatch(shellSource, /\/Users\//);
  assert.doesNotMatch(shellSource, /\/opt\/homebrew\/bin\/node/);
  assert.doesNotMatch(cSource, /\/Users\//);

  const syntax = spawnSync("/bin/sh", ["-n", launcher], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("Finder bundle is signed universal Mach-O with the declared macOS 12 target", () => {
  const binaryType = spawnSync("/usr/bin/file", [launcherBinary], { encoding: "utf8" });
  assert.equal(binaryType.status, 0, binaryType.stderr);
  assert.match(binaryType.stdout, /arm64/);
  assert.match(binaryType.stdout, /x86_64/);

  const loadCommands = spawnSync("/usr/bin/otool", ["-l", launcherBinary], {
    encoding: "utf8",
  });
  assert.equal(loadCommands.status, 0, loadCommands.stderr);
  assert.equal(loadCommands.stdout.match(/\bminos 12\.0\b/g)?.length, 2);

  const signature = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", launcherBundle],
    { encoding: "utf8" },
  );
  assert.equal(signature.status, 0, signature.stderr);
});

test("Finder app exits promptly while its detached Tunnel launcher continues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-finder-detach-"));
  const fakeClient = join(directory, "tunnel-client");
  const pidFile = join(directory, "tunnel.pid");
  const logDirectory = join(directory, "logs");
  const stateDirectory = join(directory, "state");
  let tunnelPid: number | undefined;

  writeFileSync(
    fakeClient,
    `#!/bin/sh\n` +
      `printf '%s\\n' "$$" >"$FAKE_PID_FILE"\n` +
      `trap 'exit 0' TERM INT\n` +
      `while :; do sleep 1; done\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeClient, 0o700);

  const startedAt = Date.now();
  const app = spawn(launcherBinary, [], {
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: "synthetic-detach-secret",
      FAKE_PID_FILE: pidFile,
      LOCAL_CODEX_BRIDGE_LOG_DIR: logDirectory,
      LOCAL_CODEX_BRIDGE_STATE_DIR: stateDirectory,
      LOCAL_CODEX_BRIDGE_TUNNEL_EXE: fakeClient,
    },
  });

  try {
    assert.equal(await waitForExit(app), 0);
    assert.ok(Date.now() - startedAt < 3_000, "Finder app did not exit promptly");
    await waitForFile(pidFile);
    tunnelPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(tunnelPid) && tunnelPid > 0);
    assert.equal(processExists(tunnelPid), true);
  } finally {
    if (tunnelPid !== undefined && processExists(tunnelPid)) {
      process.kill(tunnelPid, "SIGTERM");
      await waitForProcessExit(tunnelPid);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production launcher passes the runtime key to Tunnel only through its environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-launcher-"));
  const fakeClient = join(directory, "tunnel-client");
  const resultFile = join(directory, "result.txt");
  const logDirectory = join(directory, "logs");
  const stateDirectory = join(directory, "state");
  const syntheticSecret = "synthetic-launcher-secret";

  writeFileSync(
    fakeClient,
    `#!/bin/sh\n` +
      `printf 'argument_1=%s\\nargument_2=%s\\nargument_3=%s\\n' "$1" "$2" "$3" >"$FAKE_RESULT"\n` +
      `if [ -n "\${CONTROL_PLANE_API_KEY:-}" ]; then printf 'credential=present\\n' >>"$FAKE_RESULT"; fi\n` +
      `printf 'fake tunnel started\\n'\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeClient, 0o700);

  try {
    const result = spawnSync("/bin/sh", [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: syntheticSecret,
        FAKE_RESULT: resultFile,
        LOCAL_CODEX_BRIDGE_LOG_DIR: logDirectory,
        LOCAL_CODEX_BRIDGE_STATE_DIR: stateDirectory,
        LOCAL_CODEX_BRIDGE_TUNNEL_EXE: fakeClient,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(
      readFileSync(resultFile, "utf8"),
      "argument_1=run\nargument_2=--profile\nargument_3=mac-codex-bridge-production\ncredential=present\n",
    );
    assert.doesNotMatch(
      readFileSync(join(logDirectory, "production-tunnel.log"), "utf8"),
      new RegExp(syntheticSecret),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launcher lock is held across Tunnel exec and released on process exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-launch-lock-"));
  const fakeClient = join(directory, "tunnel-client");
  const resultFile = join(directory, "started.txt");
  const logDirectory = join(directory, "logs");
  const stateDirectory = join(directory, "state");
  const lockFile = join(stateDirectory, "production-tunnel.launch.lock");

  writeFileSync(
    fakeClient,
    `#!/bin/sh\n` +
      `printf 'started\\n' >"$FAKE_RESULT"\n` +
      `trap 'exit 0' TERM INT\n` +
      `while :; do sleep 1; done\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeClient, 0o700);

  const child = spawn("/bin/sh", [launcher], {
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: "synthetic-lock-secret",
      FAKE_RESULT: resultFile,
      LOCAL_CODEX_BRIDGE_LOG_DIR: logDirectory,
      LOCAL_CODEX_BRIDGE_STATE_DIR: stateDirectory,
      LOCAL_CODEX_BRIDGE_TUNNEL_EXE: fakeClient,
    },
  });

  try {
    await waitForFile(resultFile);
    const contended = spawnSync(
      "/usr/bin/lockf",
      ["-s", "-t", "0", lockFile, "/usr/bin/true"],
    );
    assert.notEqual(contended.status, 0);
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
  }

  try {
    const released = spawnSync(
      "/usr/bin/lockf",
      ["-s", "-t", "0", lockFile, "/usr/bin/true"],
    );
    assert.equal(released.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
