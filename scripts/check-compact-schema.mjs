import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCompactDescriptorSource, RAW_NOTIFICATION_SCHEMAS } from "./compact-descriptor-core.mjs";

function generate(executable, kind, output, root) {
  const generated = spawnSync(executable, ["app-server", kind, "--experimental", "--out", output], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error(`${kind} failed: ${generated.stderr || generated.stdout}`);
}

export function checkCompactSchema({ root, executable, runGenerator = generate }) {
if (!executable) throw new Error("CODEX_EXE is required for installed compact schema qualification");
const temporaryRoot = path.join(root, "_codex_tmp");
mkdirSync(temporaryRoot, { recursive: true });
// An empty, exclusive directory is the provenance boundary. A successful partial
// generator cannot inherit any artifact from a previous invocation.
const invocation = mkdtempSync(path.join(temporaryRoot, "compact_schema_check-"));
try {
const output = path.join(invocation, "typescript");
const schemaOutput = path.join(invocation, "json-schema");
runGenerator(executable, "generate-ts", output, root);
runGenerator(executable, "generate-json-schema", schemaOutput, root);
const methods = [...readFileSync(path.join(output, "ServerNotification.ts"), "utf8").matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]);
const types = [...readFileSync(path.join(output, "v2", "ThreadItem.ts"), "utf8").matchAll(/"type": "([^"]+)"/g)].map((match) => match[1]);
const fixture = readFileSync(path.join(root, "test", "compact-installed-schema.ts"), "utf8");
function fixtureArray(name) {
  const match = fixture.match(new RegExp(`export const ${name} = (\\[[\\s\\S]*?\\]) as const;`));
  if (!match) throw new Error(`missing ${name} in compact installed schema fixture`);
  return JSON.parse(match[1]);
}
const expectedMethods = fixtureArray("INSTALLED_NOTIFICATION_METHODS");
const expectedTypes = fixtureArray("INSTALLED_THREAD_ITEM_TYPES");
const missing = (expected, actual) => expected.filter((value) => !actual.includes(value));
const addedMethods = missing(methods, expectedMethods);
const addedTypes = missing(types, expectedTypes);
const removedMethods = missing(expectedMethods, methods);
const removedTypes = missing(expectedTypes, types);
if (addedMethods.length || addedTypes.length || removedMethods.length || removedTypes.length ||
    new Set(methods).size !== methods.length || new Set(types).size !== types.length) {
  throw new Error(JSON.stringify({ addedMethods, addedTypes, removedMethods, removedTypes }));
}
const descriptor = buildCompactDescriptorSource(schemaOutput, methods);
// Git may use CRLF in a Windows checkout; schema content must still match exactly.
const checkedIn = readFileSync(path.join(root, "src", "compact-descriptors.ts"), "utf8").replace(/\r\n/g, "\n");
if (descriptor !== checkedIn) throw new Error("Installed compact notification shape changed; regenerate and review src/compact-descriptors.ts");
for (const [method, filename] of Object.entries(RAW_NOTIFICATION_SCHEMAS)) {
  const typeName = filename.replace(/\.json$/, ".ts");
  const generatedType = readFileSync(path.join(output, "v2", typeName), "utf8");
  if (!generatedType.includes("export type ") || !methods.includes(method)) throw new Error(`Missing TS-only notification: ${method}`);
}
return { notifications: methods.length, itemTypes: types.length };
} finally {
  rmSync(invocation, { recursive: true, force: true });
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkCompactSchema({ root, executable: process.env.CODEX_EXE });
  console.log(`Installed compact schema matches fixture and shape descriptors: ${result.notifications} notifications, ${result.itemTypes} item types (85 union + 2 TS-only).`);
}
