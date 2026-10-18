import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
export const UX_PROJECTION_ENV = "LOCAL_CODEX_BRIDGE_UX_PROJECTION";
export const LEGACY_UX_PROJECTION_ENV = "LUMEN_CODEX_V2_UX_PROJECTION";
export class AtomicUxProjection {
    filePath;
    signalLimit;
    #generation = {
        id: randomUUID(),
        pid: process.pid,
        started_at: new Date().toISOString(),
    };
    #signals = [];
    #sequence = 0;
    constructor(filePath, signalLimit = 32) {
        this.filePath = filePath;
        this.signalLimit = signalLimit;
        if (!isAbsolute(filePath)) {
            throw new Error(`${UX_PROJECTION_ENV} must be an absolute path`);
        }
        if (!Number.isInteger(signalLimit) || signalLimit < 1 || signalLimit > 256) {
            throw new Error("signalLimit must be an integer from 1 through 256");
        }
    }
    publish(counts, signal) {
        if (signal) {
            this.#sequence += 1;
            this.#signals.push({
                ...signal,
                sequence: this.#sequence,
                at: new Date().toISOString(),
            });
            if (this.#signals.length > this.signalLimit) {
                this.#signals.splice(0, this.#signals.length - this.signalLimit);
            }
        }
        const document = {
            schema_version: 1,
            generation: this.#generation,
            sequence: this.#sequence,
            counts: { ...counts },
            signals: [...this.#signals],
        };
        this.#writeAtomic(`${JSON.stringify(document)}\n`);
    }
    close() {
        rmSync(this.filePath, { force: true });
    }
    #writeAtomic(content) {
        const directory = dirname(this.filePath);
        mkdirSync(directory, { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
            renameSync(temporary, this.filePath);
        }
        finally {
            rmSync(temporary, { force: true });
        }
    }
}
export function createUxProjectionFromEnvironment(environment = process.env) {
    const configured = environment[UX_PROJECTION_ENV]?.trim() ||
        environment[LEGACY_UX_PROJECTION_ENV]?.trim();
    return configured ? new AtomicUxProjection(resolve(configured)) : undefined;
}
