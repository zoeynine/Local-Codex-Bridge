import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const RAW_NOTIFICATION_SCHEMAS = Object.freeze({
  "rawResponseItem/completed": "RawResponseItemCompletedNotification.json",
  "rawResponse/completed": "RawResponseCompletedNotification.json",
});

const omitted = new Set(["$schema", "description", "title", "default", "examples"]);
const structural = new Set(["$ref", "type", "enum", "oneOf", "anyOf", "allOf", "items", "required", "properties", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format"]);

function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function canonicalLiteral(value) {
  if (Array.isArray(value)) return value.map(canonicalLiteral);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalLiteral(item)]));
}
function canonical(shape) {
  if (typeof shape === "boolean") return shape;
  return Object.fromEntries(Object.entries(shape).filter(([key]) => !omitted.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    // Annotation names are omitted only on schema nodes, never on property maps
    // or enum values. A native property named "title" still has a real shape.
    if (key === "properties") return [key, Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, canonical(child)]))];
    if (["oneOf", "anyOf", "allOf"].includes(key)) return [key, value.map(canonical)];
    if (["items", "additionalProperties"].includes(key)) return [key, canonical(value)];
    return [key, canonicalLiteral(value)];
  }));
}

export function buildCompactDescriptorSource(schemaDir, installedMethods) {
  const union = readJson(path.join(schemaDir, "ServerNotification.json"));
  const rawMethods = Object.keys(RAW_NOTIFICATION_SCHEMAS);
  const methods = {};
  const definitions = { ...union.definitions };
  for (const variant of union.oneOf) {
    const method = variant.properties?.method?.enum?.[0];
    const params = variant.properties?.params;
    if (!method || !params || Object.hasOwn(methods, method)) throw new Error("Invalid ServerNotification variant");
    methods[method] = params;
  }
  const unionMethods = Object.keys(methods);
  const expectedUnion = installedMethods.filter((method) => !rawMethods.includes(method));
  if (JSON.stringify([...unionMethods].sort()) !== JSON.stringify([...expectedUnion].sort()) || unionMethods.length !== 85 || installedMethods.length !== 87) {
    throw new Error(`ServerNotification union mismatch: union=${unionMethods.length}, installed=${installedMethods.length}, omitted=${JSON.stringify(installedMethods.filter((method) => !unionMethods.includes(method)))}`);
  }
  for (const [method, filename] of Object.entries(RAW_NOTIFICATION_SCHEMAS)) {
    const raw = readJson(path.join(schemaDir, "v2", filename));
    const prefix = method.replaceAll("/", "_") + "__";
    const qualify = (value) => {
      if (Array.isArray(value)) return value.map(qualify);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "$ref" ? item.replace("#/definitions/", `#/definitions/${prefix}`) : qualify(item)]));
    };
    methods[method] = qualify(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "definitions")));
    for (const [name, shape] of Object.entries(raw.definitions ?? {})) definitions[prefix + name] = qualify(shape);
  }
  const reachable = new Set();
  function visit(value) {
    if (value === true || value === false) return;
    if (!value || typeof value !== "object") throw new Error("Invalid descriptor node");
    for (const key of Object.keys(value)) {
      if (!structural.has(key) && !omitted.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    }
    if (value.$ref) {
      const name = value.$ref.replace("#/definitions/", "");
      if (!Object.hasOwn(definitions, name)) throw new Error(`Unresolved compact schema ref: ${name}`);
      if (!reachable.has(name)) { reachable.add(name); visit(definitions[name]); }
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) for (const branch of value[key] ?? []) visit(branch);
    if (value.items !== undefined) visit(value.items);
    if (value.additionalProperties !== undefined && typeof value.additionalProperties === "object") visit(value.additionalProperties);
    for (const child of Object.values(value.properties ?? {})) visit(child);
  }
  for (const shape of Object.values(methods)) visit(shape);
  const descriptor = {
    methods: Object.fromEntries(Object.entries(methods).sort(([a], [b]) => a.localeCompare(b)).map(([name, shape]) => [name, canonical(shape)])),
    definitions: Object.fromEntries([...reachable].sort().map((name) => [name, canonical(definitions[name])])),
  };
  const shapeFingerprint = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  return [
    "// Generated from installed codex-cli experimental JSON schema. Run npm run check:compact-schema after upgrades.",
    "// rawResponse* are TS-only ServerNotification methods; their standalone v2 JSON schemas supply the shapes.",
    "// Runtime shapes follow JSON schema. TS supplies method/item coverage only; TS-only field changes require protocol review.",
    'import type { CompactDescriptorBundle } from "./compact-shape.js";',
    `export const COMPACT_SCHEMA_FINGERPRINT = ${JSON.stringify(shapeFingerprint)};`,
    `export const NOTIFICATION_SHAPES: CompactDescriptorBundle = ${JSON.stringify(descriptor, null, 2)};`,
    "",
  ].join("\n");
}
