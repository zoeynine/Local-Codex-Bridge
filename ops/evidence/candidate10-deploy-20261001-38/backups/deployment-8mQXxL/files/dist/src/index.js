import { AppServerManager } from "./app-server.js";
import { McpStdioServer } from "./mcp.js";
import { sanitizeForTransport } from "./runtime.js";
import { RuntimeStore } from "./runtime.js";
import { ControlSurface } from "./tools.js";
import { createUxProjectionFromEnvironment } from "./ux-projection.js";
const uxProjection = createUxProjectionFromEnvironment();
const appServer = new AppServerManager(new RuntimeStore(256, uxProjection));
const control = new ControlSurface(appServer);
let shuttingDown = false;
let server;
async function shutdown(exitCode = 0) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = Math.max(currentExitCode, exitCode);
    await server.close();
    await appServer.close();
    appServer.runtime.closeUxProjection();
}
function reportFatal(error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = sanitizeForTransport(message, {
        maxStringChars: 4_000,
        totalCharBudget: 4_000,
    });
    process.stderr.write(`local-codex-bridge: ${String(safe)}\n`);
}
server = new McpStdioServer(control, {
    onClose: () => shutdown(0),
});
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("uncaughtException", (error) => {
    reportFatal(error);
    void shutdown(1);
});
process.once("unhandledRejection", (error) => {
    reportFatal(error);
    void shutdown(1);
});
server.start();
