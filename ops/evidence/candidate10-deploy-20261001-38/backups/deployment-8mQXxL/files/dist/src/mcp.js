import { sanitizeForTransport } from "./runtime.js";
import { ControlSurface, TOOL_DEFINITIONS, TOOL_NAMES } from "./tools.js";
import { VERSION } from "./version.js";
const JSONRPC_VERSION = "2.0";
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
]);
const MAX_LINE_BYTES = 10 * 1024 * 1024;
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function validId(value) {
    return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}
function idKey(value) {
    return `${typeof value}:${String(value)}`;
}
function safeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeForTransport(message, {
        maxStringChars: 4_000,
        totalCharBudget: 4_000,
    });
    return typeof sanitized === "string" ? sanitized : "Tool call failed";
}
function initializeCompatibility(params) {
    const record = asRecord(params);
    if (typeof record?.protocolVersion !== "string") {
        return null;
    }
    return {
        protocolVersion: record.protocolVersion,
        capabilities: record.capabilities,
        clientInfo: record.clientInfo,
    };
}
function structurallyEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => structurallyEqual(value, right[index]));
    }
    const leftRecord = asRecord(left);
    const rightRecord = asRecord(right);
    if (!leftRecord || !rightRecord) {
        return false;
    }
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]));
}
function initializeMismatch(first, repeated) {
    if (!first || first.protocolVersion !== repeated.protocolVersion) {
        return "protocolVersion";
    }
    if (!structurallyEqual(first.capabilities, repeated.capabilities)) {
        return "capabilities";
    }
    if (!structurallyEqual(first.clientInfo, repeated.clientInfo)) {
        return "clientInfo";
    }
    return null;
}
export class McpStdioServer {
    #cancelled = new Set();
    #activeRequests = new Set();
    #requestControllers = new Map();
    #control;
    #onClose;
    #buffer = Buffer.alloc(0);
    #initializeResult = null;
    #initializeCompatibility = null;
    #closing = false;
    #writeChain = Promise.resolve();
    constructor(control, options) {
        this.#control = control;
        this.#onClose = options.onClose;
    }
    start() {
        process.stdin.on("data", this.#onData);
        process.stdin.once("end", this.#onInputClose);
        process.stdin.once("close", this.#onInputClose);
        process.stdin.once("error", this.#onInputError);
        process.stdin.resume();
    }
    async close() {
        if (this.#closing) {
            return;
        }
        this.#closing = true;
        this.#abortActiveRequests();
        process.stdin.off("data", this.#onData);
        process.stdin.off("end", this.#onInputClose);
        process.stdin.off("close", this.#onInputClose);
        process.stdin.off("error", this.#onInputError);
        process.stdin.pause();
        await this.#writeChain.catch(() => undefined);
    }
    #onData = (chunk) => {
        if (this.#closing) {
            return;
        }
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (true) {
            const newline = this.#buffer.indexOf(0x0a);
            if (newline < 0) {
                if (this.#buffer.length > MAX_LINE_BYTES) {
                    this.#buffer = Buffer.alloc(0);
                    void this.#sendError(undefined, {
                        code: -32700,
                        message: "MCP stdio JSON line exceeds 10 MiB",
                    });
                }
                return;
            }
            if (newline > MAX_LINE_BYTES) {
                this.#buffer = this.#buffer.subarray(newline + 1);
                void this.#sendError(undefined, {
                    code: -32700,
                    message: "MCP stdio JSON line exceeds 10 MiB",
                });
                continue;
            }
            let line = this.#buffer.subarray(0, newline);
            this.#buffer = this.#buffer.subarray(newline + 1);
            if (line.at(-1) === 0x0d) {
                line = line.subarray(0, -1);
            }
            if (line.length === 0) {
                continue;
            }
            this.#acceptLine(line);
        }
    };
    #onInputClose = () => {
        if (!this.#closing) {
            this.#abortActiveRequests();
            void this.#onClose();
        }
    };
    #onInputError = (error) => {
        if (!this.#closing) {
            this.#abortActiveRequests();
            void this.#sendError(undefined, {
                code: -32603,
                message: `MCP stdin failed: ${safeErrorMessage(error)}`,
            }).finally(() => this.#onClose());
        }
    };
    #acceptLine(line) {
        let message;
        try {
            message = JSON.parse(line.toString("utf8"));
        }
        catch {
            void this.#sendError(undefined, { code: -32700, message: "Parse error" });
            return;
        }
        const record = asRecord(message);
        if (!record || record.jsonrpc !== JSONRPC_VERSION || typeof record.method !== "string") {
            const id = record && validId(record.id) ? record.id : undefined;
            void this.#sendError(id, { code: -32600, message: "Invalid Request" });
            return;
        }
        if (record.id !== undefined && !validId(record.id)) {
            void this.#sendError(undefined, { code: -32600, message: "Invalid Request" });
            return;
        }
        if (record.id === undefined) {
            this.#handleNotification(record.method, record.params);
            return;
        }
        const key = idKey(record.id);
        if (this.#activeRequests.has(key)) {
            void this.#sendProtocolError(record.id, {
                code: -32600,
                message: "Duplicate request id is already active",
            });
            return;
        }
        const controller = new AbortController();
        this.#activeRequests.add(key);
        this.#requestControllers.set(key, controller);
        void this.#handleRequest(record.id, record.method, record.params, controller.signal).finally(() => {
            this.#activeRequests.delete(key);
            this.#requestControllers.delete(key);
            this.#cancelled.delete(key);
        });
    }
    #handleNotification(method, params) {
        if (method === "notifications/cancelled") {
            const requestId = asRecord(params)?.requestId;
            if (validId(requestId) && this.#activeRequests.has(idKey(requestId))) {
                const key = idKey(requestId);
                this.#cancelled.add(key);
                this.#requestControllers.get(key)?.abort();
            }
        }
        // notifications/initialized and unknown notifications intentionally have no response.
    }
    async #handleRequest(id, method, params, signal) {
        if (method === "initialize") {
            const compatibility = initializeCompatibility(params);
            if (this.#initializeResult !== null) {
                if (!compatibility) {
                    await this.#sendError(id, { code: -32602, message: "initialize requires protocolVersion" });
                    return;
                }
                const mismatch = initializeMismatch(this.#initializeCompatibility, compatibility);
                if (mismatch) {
                    await this.#sendError(id, {
                        code: -32602,
                        message: `initialize request is incompatible with the established session: ${mismatch} differs`,
                    });
                    return;
                }
                await this.#sendResult(id, this.#initializeResult);
                return;
            }
            if (!compatibility) {
                await this.#sendError(id, { code: -32602, message: "initialize requires protocolVersion" });
                return;
            }
            const initializeResult = {
                protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(compatibility.protocolVersion)
                    ? compatibility.protocolVersion
                    : LATEST_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: {
                    name: "local-codex-bridge",
                    title: "Local Codex Bridge",
                    version: VERSION,
                },
            };
            this.#initializeCompatibility = compatibility;
            this.#initializeResult = initializeResult;
            await this.#sendResult(id, initializeResult);
            return;
        }
        if (this.#initializeResult === null) {
            await this.#sendError(id, { code: -32002, message: "Server not initialized" });
            return;
        }
        if (method === "ping") {
            await this.#sendResult(id, {});
            return;
        }
        if (method === "tools/list") {
            await this.#sendResult(id, { tools: TOOL_DEFINITIONS });
            return;
        }
        if (method !== "tools/call") {
            await this.#sendError(id, { code: -32601, message: `Method not found: ${method}` });
            return;
        }
        const call = asRecord(params);
        const name = call?.name;
        const toolArguments = call?.arguments ?? {};
        if (typeof name !== "string" || !TOOL_NAMES.includes(name)) {
            await this.#sendError(id, { code: -32602, message: "Unknown tool" });
            return;
        }
        if (!asRecord(toolArguments)) {
            await this.#sendError(id, { code: -32602, message: "Tool arguments must be an object" });
            return;
        }
        try {
            const result = await this.#control.call(name, toolArguments, name === "codex_observe" ? signal : undefined);
            await this.#sendResult(id, {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result),
                    },
                ],
            });
        }
        catch (error) {
            await this.#sendResult(id, {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: safeErrorMessage(error) }),
                    },
                ],
                isError: true,
            });
        }
    }
    async #sendResult(id, result) {
        if (this.#cancelled.delete(idKey(id))) {
            return;
        }
        await this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
    }
    async #sendError(id, error) {
        if (id !== undefined && this.#cancelled.delete(idKey(id))) {
            return;
        }
        await this.#write({
            jsonrpc: JSONRPC_VERSION,
            ...(id !== undefined ? { id } : {}),
            error,
        });
    }
    async #sendProtocolError(id, error) {
        await this.#write({ jsonrpc: JSONRPC_VERSION, id, error });
    }
    #abortActiveRequests() {
        for (const [key, controller] of this.#requestControllers) {
            this.#cancelled.add(key);
            controller.abort();
        }
    }
    async #write(message) {
        const payload = `${JSON.stringify(message)}\n`;
        const write = async () => {
            if (!process.stdout.writable) {
                throw new Error("MCP stdout is not writable");
            }
            await new Promise((resolve, reject) => {
                process.stdout.write(payload, "utf8", (error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
            });
        };
        this.#writeChain = this.#writeChain.then(write, write);
        await this.#writeChain;
    }
}
