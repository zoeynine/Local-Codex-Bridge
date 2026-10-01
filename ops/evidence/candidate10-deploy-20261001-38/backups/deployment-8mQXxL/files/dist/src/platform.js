import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
function childHasExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}
function validateWindowsCwd(value) {
    if (value.includes("\0")) {
        throw new Error("cwd contains a NUL character");
    }
    if (/^(?:\\\\|\/\/|\\\\[?.]\\|\\[?.]\\)/.test(value)) {
        throw new Error("cwd must not be a UNC or Windows device path");
    }
    if (!/^[A-Za-z]:[\\/]/.test(value) || !path.win32.isAbsolute(value)) {
        throw new Error("cwd must be an absolute Windows drive-letter path");
    }
    return path.win32.normalize(value);
}
function validateDarwinCwd(value) {
    if (value.includes("\0")) {
        throw new Error("cwd contains a NUL character");
    }
    if (!path.posix.isAbsolute(value)) {
        throw new Error("cwd must be an absolute POSIX path on macOS");
    }
    return path.posix.normalize(value);
}
function normalizeWindowsExplicitCheckpointDirectory(value) {
    if (!path.win32.isAbsolute(value)) {
        throw new Error("Explicit checkpoint directory must be an absolute Windows path");
    }
    return path.win32.resolve(value);
}
function normalizeDarwinExplicitCheckpointDirectory(value) {
    if (!path.posix.isAbsolute(value)) {
        throw new Error("Explicit checkpoint directory must be an absolute POSIX path on macOS");
    }
    return path.posix.resolve(value);
}
function defaultWindowsCheckpointDirectory(environment, homeDirectory, pathExists) {
    const localAppData = environment.LOCALAPPDATA?.trim();
    const userProfile = environment.USERPROFILE?.trim() || homeDirectory;
    const base = localAppData || path.win32.join(userProfile, "AppData", "Local");
    if (!path.win32.isAbsolute(base)) {
        throw new Error("Unable to resolve an absolute local app-data directory for checkpoints");
    }
    const legacyDefault = path.win32.join(base, "Lumen", "CodexControlV2", "checkpoints");
    if (pathExists(legacyDefault)) {
        return legacyDefault;
    }
    return path.win32.join(base, "LocalCodexBridge", "checkpoints");
}
function defaultDarwinCheckpointDirectory(_environment, homeDirectory) {
    if (!path.posix.isAbsolute(homeDirectory)) {
        throw new Error("Unable to resolve an absolute macOS home directory for checkpoints");
    }
    return path.posix.join(homeDirectory, "Library", "Application Support", "LocalCodexBridge", "checkpoints");
}
const runTaskkill = (executable, args, options) => spawnSync(executable, [...args], options);
export function createWindowsPlatformPolicy(taskkillRunner = runTaskkill, pathExists = existsSync) {
    return {
        platform: "win32",
        nativeCwdDescription: "absolute Windows drive-letter path",
        validateCwd: validateWindowsCwd,
        normalizeExplicitCheckpointDirectory: normalizeWindowsExplicitCheckpointDirectory,
        resolveDefaultCheckpointDirectory: (environment, homeDirectory) => defaultWindowsCheckpointDirectory(environment, homeDirectory, pathExists),
        appServerSpawnOptions: () => ({ shell: false, windowsHide: true }),
        hasChildExited: childHasExited,
        softTerminateChild: (child) => {
            child.kill();
        },
        hardTerminateChild: (child) => {
            if (child.pid === undefined) {
                throw new Error("Cannot hard-terminate Codex app-server without a process id");
            }
            const result = taskkillRunner("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
            if (result.error) {
                throw new Error(`Failed to run taskkill.exe: ${result.error.message}`);
            }
            if (result.status !== 0) {
                throw new Error(`taskkill.exe failed for Codex app-server pid ${child.pid} (status=${String(result.status)})`);
            }
        },
    };
}
export const WINDOWS_PLATFORM_POLICY = createWindowsPlatformPolicy();
export const DARWIN_PLATFORM_POLICY = {
    platform: "darwin",
    nativeCwdDescription: "absolute POSIX path on macOS",
    validateCwd: validateDarwinCwd,
    normalizeExplicitCheckpointDirectory: normalizeDarwinExplicitCheckpointDirectory,
    resolveDefaultCheckpointDirectory: defaultDarwinCheckpointDirectory,
    appServerSpawnOptions: () => ({ shell: false }),
    hasChildExited: childHasExited,
    softTerminateChild: (child) => {
        child.kill("SIGTERM");
    },
    hardTerminateChild: (child) => {
        child.kill("SIGKILL");
    },
};
export function platformPolicyFor(platform = process.platform) {
    if (platform === "win32") {
        return WINDOWS_PLATFORM_POLICY;
    }
    if (platform === "darwin") {
        return DARWIN_PLATFORM_POLICY;
    }
    throw new Error(`Unsupported platform ${platform}; Local Codex Bridge supports Windows and macOS only`);
}
