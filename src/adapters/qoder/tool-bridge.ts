import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  namespacedToolName,
  toolChoiceToolPredicate,
  type OcxParsedRequest,
  type OcxTool,
  type OcxToolChoice,
} from "../../types";
import { stripResponsesOnlyEncryptedMarker } from "../responses-tool-schema";

export const QODER_MCP_SERVER_NAME = "opencodex";
export const QODER_MCP_TOOL_PREFIX = `mcp__${QODER_MCP_SERVER_NAME}__`;

// These caps protect both the request path and the isolated MCP process. They sit
// below the adapter's 4 MiB total prompt cap so a maximal tool catalog cannot
// crowd the transcript and system prompt out of the request budget.
export const QODER_TOOL_LIMITS = Object.freeze({
  maxTools: 128,
  // Side-channel v1 delivers only the first call in a Qoder invocation.
  // Extra calls stay unexecuted; the host can continue in a new invocation.
  maxTurnToolCalls: 1,
  maxNameBytes: 512,
  maxDescriptionBytes: 64 * 1024,
  maxSchemaBytes: 224 * 1024,
  maxToolBytes: 256 * 1024,
  maxCatalogBytes: 2 * 1024 * 1024,
  maxSchemaDepth: 32,
  maxSchemaNodes: 4_096,
  maxPatternBytes: 8 * 1024,
});

// Qoder renders MCP tools as `mcp__<server>__<tool>`. Keep the complete
// rendered name comfortably below the common 64-character function-name limit.
const MAX_QODER_TOOL_ALIAS_CHARS = 40;
const QODER_TOOL_ALIAS_HASH_CHARS = 16;
const QODER_TOOL_ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVALID_TOOL_NAME_PATTERN = /[\s\u0000-\u001f\u007f]/u;
const INVALID_DESCRIPTION_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const SCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;
const SCHEMA_VALUE_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SCHEMA_ARRAY_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;
const NON_NEGATIVE_INTEGER_KEYWORDS = [
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
] as const;
const FINITE_NUMBER_KEYWORDS = [
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
] as const;
const STRING_KEYWORDS = [
  "$anchor",
  "$comment",
  "$id",
  "$schema",
  "$dynamicAnchor",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "title",
] as const;
const BOOLEAN_KEYWORDS = [
  "deprecated",
  "nullable",
  "readOnly",
  "uniqueItems",
  "writeOnly",
] as const;
const textEncoder = new TextEncoder();

const DRAFT_07_SCHEMA_URIS = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2019_09_SCHEMA_URIS = new Set([
  "http://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2019-09/schema",
]);
const DRAFT_2020_12_SCHEMA_URIS = new Set([
  "http://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema",
]);

// Keywords introduced in draft 2019-09. When a catalog omits `$schema` we
// default to draft-07 (the SDK's historical behavior), so any modern keyword
// would otherwise be silently ignored by the draft-07 compiler. Rejecting
// instead of dropping a constraint keeps validation faithful to the declared
// schema (F04).
const KEYWORDS_2019_09_OR_LATER = new Set([
  "$defs",
  "$recursiveAnchor",
  "$recursiveRef",
  "contentSchema",
  "dependentRequired",
  "dependentSchemas",
  "maxContains",
  "minContains",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
// `prefixItems` replaced the draft-07 tuple form of `items` in 2020-12; the
// 2019-09 compiler would silently ignore it. The dynamic-reference pair and
// `$vocabulary` versioning also arrive with 2020-12.
const KEYWORDS_2020_12_ONLY = new Set([
  "$dynamicAnchor",
  "$dynamicRef",
  "prefixItems",
]);

export interface QoderMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface QoderToolBridge {
  tools: QoderMcpToolDefinition[];
  /** Exact nested-CLI-emitted MCP name -> Responses wire name. */
  emittedNameMap: Map<string, string>;
  requireToolCall: boolean;
  /**
   * Request-local, precompiled argument validation keyed by the advertised MCP
   * alias. Returns an error string when the arguments are invalid or the tool
   * is not advertised, and undefined when they validate. The empty `none`
   * bridge always fails closed.
   */
  validateArguments: (
    name: string,
    args: Record<string, unknown>,
  ) => string | undefined;
}

interface PreparedTool {
  source: OcxTool;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  dialect: DialectDecision | undefined;
}

interface JsonCloneState {
  active: WeakSet<object>;
  nodes: number;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defineDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  // `__proto__` is a valid JSON Schema property name. Defining it as data keeps
  // it from invoking Object.prototype's legacy setter while retaining a normal
  // object prototype for downstream SDKs.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function invalidJson(reason: string): never {
  throw new Error(`invalid JSON value (${reason})`);
}

/**
 * Clone one schema into inert JSON data. A bounded recursive walk is safe here:
 * the depth check happens before descent, and the resulting maximum call depth
 * is fixed rather than attacker-controlled.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
function cloneBoundedJson(
  value: unknown,
  depth: number,
  state: JsonCloneState,
): JsonValue {
  if (depth > QODER_TOOL_LIMITS.maxSchemaDepth)
    invalidJson("nesting is too deep");
  state.nodes += 1;
  if (state.nodes > QODER_TOOL_LIMITS.maxSchemaNodes)
    invalidJson("node count is too large");

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string" && hasUnpairedSurrogate(value))
      invalidJson("text contains an unpaired surrogate");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidJson("numbers must be finite");
    return value;
  }
  if (typeof value !== "object") invalidJson(`unsupported ${typeof value}`);

  const object = value as object;
  if (state.active.has(object)) invalidJson("cycles are not allowed");
  state.active.add(object);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        invalidJson("arrays must use the built-in prototype");
      if (value.length > QODER_TOOL_LIMITS.maxSchemaNodes)
        invalidJson("array length is too large");

      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
          invalidJson("arrays may not have custom properties");
        }
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length
        ) {
          invalidJson("array index is invalid");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          invalidJson("array entries must be enumerable data properties");
        }
      }
      if (keys.length - 1 !== value.length)
        invalidJson("sparse arrays are not allowed");

      return value.map((entry) => cloneBoundedJson(entry, depth + 1, state));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      invalidJson("objects must be plain records");
    const out: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidJson("symbol keys are not allowed");
      if (hasUnpairedSurrogate(key))
        invalidJson("property name contains an unpaired surrogate");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalidJson("object fields must be enumerable data properties");
      }
      defineDataProperty(
        out,
        key,
        cloneBoundedJson(descriptor.value, depth + 1, state),
      );
    }
    return out;
  } finally {
    state.active.delete(object);
  }
}

function invalidSchema(reason: string): never {
  throw new Error(reason);
}

function assertStringArray(
  value: unknown,
  keyword: string,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidSchema(
      `${keyword} must be ${allowEmpty ? "an" : "a non-empty"} array of unique strings`,
    );
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) {
      invalidSchema(
        `${keyword} must be ${allowEmpty ? "an" : "a non-empty"} array of unique strings`,
      );
    }
    seen.add(item);
  }
  return value as string[];
}

function assertSchema(value: unknown, keyword: string): void {
  if (typeof value === "boolean") return;
  if (!isRecord(value)) invalidSchema(`${keyword} must contain a JSON Schema`);
  validateSchema(value);
}

function validateSchemaMap(
  value: unknown,
  keyword: string,
  validatePatterns = false,
): void {
  if (!isRecord(value))
    invalidSchema(`${keyword} must be an object of JSON Schemas`);
  for (const [name, schema] of Object.entries(value)) {
    if (validatePatterns) validatePattern(name, `${keyword} key`);
    assertSchema(schema, `${keyword}.${name}`);
  }
}

function validatePattern(value: unknown, keyword = "pattern"): void {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > QODER_TOOL_LIMITS.maxPatternBytes
  ) {
    invalidSchema(`${keyword} must be a bounded regular-expression string`);
  }
  try {
    new RegExp(value, "u");
  } catch {
    invalidSchema(`${keyword} is not a valid regular expression`);
  }
}

function validateSchema(schema: Record<string, unknown>): void {
  if (Object.hasOwn(schema, "type")) {
    const type = schema.type;
    if (typeof type === "string") {
      if (!JSON_SCHEMA_TYPES.has(type))
        invalidSchema("type contains an unknown JSON Schema type");
    } else {
      const types = assertStringArray(type, "type", false);
      if (types.some((candidate) => !JSON_SCHEMA_TYPES.has(candidate))) {
        invalidSchema("type contains an unknown JSON Schema type");
      }
    }
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      validateSchemaMap(
        schema[keyword],
        keyword,
        keyword === "patternProperties",
      );
    }
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) assertSchema(schema[keyword], keyword);
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (
      !Array.isArray(value) ||
      (keyword !== "prefixItems" && value.length === 0)
    ) {
      invalidSchema(
        `${keyword} must be an array of JSON Schemas${keyword === "prefixItems" ? "" : " with at least one entry"}`,
      );
    }
    for (const entry of value) assertSchema(entry, keyword);
  }

  if (Object.hasOwn(schema, "items")) {
    const items = schema.items;
    if (Array.isArray(items)) {
      for (const entry of items) assertSchema(entry, "items");
    } else {
      assertSchema(items, "items");
    }
  }
  if (Object.hasOwn(schema, "required"))
    assertStringArray(schema.required, "required");
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      invalidSchema("enum must be a non-empty array");
  }
  if (Object.hasOwn(schema, "examples") && !Array.isArray(schema.examples)) {
    invalidSchema("examples must be an array");
  }

  for (const keyword of NON_NEGATIVE_INTEGER_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      invalidSchema(`${keyword} must be a non-negative safe integer`);
    }
  }
  for (const keyword of FINITE_NUMBER_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    if (
      typeof schema[keyword] !== "number" ||
      !Number.isFinite(schema[keyword])
    ) {
      invalidSchema(`${keyword} must be a finite number`);
    }
  }
  if (Object.hasOwn(schema, "multipleOf")) {
    if (
      typeof schema.multipleOf !== "number" ||
      !Number.isFinite(schema.multipleOf) ||
      schema.multipleOf <= 0
    ) {
      invalidSchema("multipleOf must be a finite number greater than zero");
    }
  }

  for (const keyword of STRING_KEYWORDS) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "string") {
      invalidSchema(`${keyword} must be a string`);
    }
  }
  for (const keyword of BOOLEAN_KEYWORDS) {
    if (
      Object.hasOwn(schema, keyword) &&
      typeof schema[keyword] !== "boolean"
    ) {
      invalidSchema(`${keyword} must be a boolean`);
    }
  }
  if (Object.hasOwn(schema, "pattern")) validatePattern(schema.pattern);

  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const ref = schema[keyword];
    // External references hand resolution authority to the nested runtime and
    // can turn a data-only catalog into network or filesystem access. Local
    // JSON Pointer/anchor references retain recursive and reusable schemas.
    if (typeof ref !== "string" || !ref.startsWith("#")) {
      invalidSchema(`${keyword} must be a local fragment reference`);
    }
  }

  if (Object.hasOwn(schema, "$vocabulary")) {
    if (!isRecord(schema.$vocabulary))
      invalidSchema("$vocabulary must be an object");
    for (const enabled of Object.values(schema.$vocabulary)) {
      if (typeof enabled !== "boolean")
        invalidSchema("$vocabulary values must be booleans");
    }
  }
  if (Object.hasOwn(schema, "$async")) {
    // The bridge contract is a synchronous local JSON Schema validator.
    // Accepting `$async` would let a Promise escape the synchronous turn
    // path and be treated as a truthy validation result (F03).
    if (typeof schema.$async !== "boolean")
      invalidSchema("$async must be a boolean");
    if (schema.$async) invalidSchema("$async schemas are not supported");
  }
  if (Object.hasOwn(schema, "dependentRequired")) {
    if (!isRecord(schema.dependentRequired))
      invalidSchema("dependentRequired must be an object");
    for (const [name, required] of Object.entries(schema.dependentRequired)) {
      assertStringArray(required, `dependentRequired.${name}`);
    }
  }
  if (Object.hasOwn(schema, "dependencies")) {
    if (!isRecord(schema.dependencies))
      invalidSchema("dependencies must be an object");
    for (const [name, dependency] of Object.entries(schema.dependencies)) {
      if (Array.isArray(dependency))
        assertStringArray(dependency, `dependencies.${name}`);
      else assertSchema(dependency, `dependencies.${name}`);
    }
  }

  for (const [minimum, maximum] of [
    ["minContains", "maxContains"],
    ["minItems", "maxItems"],
    ["minLength", "maxLength"],
    ["minProperties", "maxProperties"],
  ] as const) {
    if (
      typeof schema[minimum] === "number" &&
      typeof schema[maximum] === "number" &&
      schema[minimum] > schema[maximum]
    ) {
      invalidSchema(`${minimum} must not exceed ${maximum}`);
    }
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    invalidSchema("minimum must not exceed maximum");
  }
}

interface DialectDecision {
  kind: "draft7" | "2019" | "2020";
}

/**
 * Decide which AJV dialect compiles a schema. A declared `$schema` selects
 * its dialect; anything else is rejected so validation never silently picks a
 * looser interpretation. With no declaration we default to draft-07, but a
 * modern keyword anywhere in the schema is rejected with a pointer at the
 * keyword instead of being ignored by the draft-07 compiler (F04).
 */
function schemaDialect(
  schema: Record<string, unknown>,
): DialectDecision | undefined {
  if (Object.hasOwn(schema, "$schema")) {
    if (typeof schema.$schema !== "string")
      invalidSchema("$schema must be a string");
    const uri = schema.$schema.replace(/#+$/, "");
    if (DRAFT_07_SCHEMA_URIS.has(uri)) return { kind: "draft7" };
    if (DRAFT_2019_09_SCHEMA_URIS.has(uri)) return { kind: "2019" };
    if (DRAFT_2020_12_SCHEMA_URIS.has(uri)) return { kind: "2020" };
    invalidSchema(`unsupported JSON Schema dialect: ${schema.$schema}`);
  }
  return undefined;
}

interface ModernKeywordHit {
  keyword: string;
  path: string;
  minimumDialect: "2019" | "2020";
}

function modernKeywordHit(
  schema: Record<string, unknown>,
): ModernKeywordHit | undefined {
  // Only known subschema positions contain JSON Schema keywords. Unknown
  // object-valued annotations and literal payloads are data, not schemas.
  interface ScanFrame {
    value: unknown;
    path: string;
  }
  const stack: ScanFrame[] = [{ value: schema, path: "" }];
  let first2019Hit: ModernKeywordHit | undefined;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (KEYWORDS_2019_09_OR_LATER.has(key)) {
        first2019Hit ??= {
          keyword: key,
          path: `${frame.path}/${key}`,
          minimumDialect: "2019",
        };
      }
      if (KEYWORDS_2020_12_ONLY.has(key)) {
        return { keyword: key, path: `${frame.path}/${key}`, minimumDialect: "2020" };
      }
      if (key === "dependencies") {
        if (isRecord(child)) {
          for (const [name, dependency] of Object.entries(child)) {
            stack.push({
              value: dependency,
              path: `${frame.path}/${key}/${name}`,
            });
          }
        }
        continue;
      }
      if (SCHEMA_MAP_KEYWORDS.includes(key as (typeof SCHEMA_MAP_KEYWORDS)[number])) {
        if (isRecord(child)) {
          for (const [name, sub] of Object.entries(child)) {
            stack.push({
              value: sub,
              path: `${frame.path}/${key}/${name}`,
            });
          }
        }
        continue;
      }
      if (
        key === "items" ||
        SCHEMA_ARRAY_KEYWORDS.includes(
          key as (typeof SCHEMA_ARRAY_KEYWORDS)[number],
        )
      ) {
        if (Array.isArray(child)) {
          for (let index = child.length - 1; index >= 0; index--) {
            stack.push({
              value: child[index],
              path: `${frame.path}/${key}/${index}`,
            });
          }
        } else if (key === "items") {
          stack.push({ value: child, path: `${frame.path}/${key}` });
        }
        continue;
      }
      if (
        SCHEMA_VALUE_KEYWORDS.includes(
          key as (typeof SCHEMA_VALUE_KEYWORDS)[number],
        )
      ) {
        stack.push({ value: child, path: `${frame.path}/${key}` });
      }
    }
  }
  return first2019Hit;
}

/**
 * Reject keywords the chosen dialect cannot enforce. A draft-07 default (no
 * `$schema`) or declared draft-07 cannot apply 2019-09/2020-12 keywords, and
 * a declared 2019-09 cannot apply 2020-12-only keywords. Failing loudly keeps
 * every accepted constraint from being silently ignored (F04).
 */
function assertKeywordDialect(
  schema: Record<string, unknown>,
  dialect: DialectDecision | undefined,
): void {
  const hit = modernKeywordHit(schema);
  if (!hit) return;
  const path = hit.path || "the root";
  if (dialect === undefined || dialect.kind === "draft7") {
    invalidSchema(
      `keyword ${hit.keyword} at ${path} requires the draft ${hit.minimumDialect === "2020" ? "2020-12" : "2019-09 or 2020-12"} dialect`,
    );
  }
  if (dialect.kind === "2019" && hit.minimumDialect === "2020") {
    invalidSchema(`keyword ${hit.keyword} at ${path} requires the draft 2020-12 dialect`);
  }
}

interface CompiledSchema {
  validate: ValidateFunction;
  ajv: Ajv;
}

function compileSchemaWithDialect(
  schema: Record<string, unknown>,
  dialect: DialectDecision | undefined,
): CompiledSchema {
  if (dialect === undefined || dialect.kind === "draft7") {
    const ajv = new Ajv({
      strict: false,
      validateSchema: false,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(ajv);
    return { validate: ajv.compile(schema), ajv };
  }
  if (dialect.kind === "2019") {
    const ajv2019 = new Ajv2019({
      strict: false,
      validateSchema: false,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(ajv2019 as unknown as Ajv);
    return { validate: ajv2019.compile(schema), ajv: ajv2019 as unknown as Ajv };
  }
  const ajv2020 = new Ajv2020({
    strict: false,
    validateSchema: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv2020 as unknown as Ajv);
  return { validate: ajv2020.compile(schema), ajv: ajv2020 as unknown as Ajv };
}

function normalizeInputSchema(
  parameters: unknown,
): {
  inputSchema: Record<string, unknown>;
  dialect: DialectDecision | undefined;
} {
  if (!isRecord(parameters)) invalidSchema("the root must be an object schema");
  const cloned = cloneBoundedJson(parameters, 0, {
    active: new WeakSet(),
    nodes: 0,
  });
  if (!isRecord(cloned)) invalidSchema("the root must be an object schema");
  if (serializedBytes(cloned) > QODER_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error(
      `schema exceeds ${QODER_TOOL_LIMITS.maxSchemaBytes} bytes`,
    );
  }
  validateSchema(cloned);
  if (Object.hasOwn(cloned, "type") && cloned.type !== "object") {
    invalidSchema('the root type must be "object"');
  }
  const dialect = schemaDialect(cloned);
  assertKeywordDialect(cloned, dialect);

  const stripped = stripResponsesOnlyEncryptedMarker(cloned);
  if (!isRecord(stripped))
    invalidSchema("the root must remain an object schema");
  if (!Object.hasOwn(stripped, "type")) stripped.type = "object";
  if (serializedBytes(stripped) > QODER_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error(
      `schema exceeds ${QODER_TOOL_LIMITS.maxSchemaBytes} bytes`,
    );
  }
  return { inputSchema: stripped, dialect };
}

function shortHash(value: string, salt = 0): string {
  return createHash("sha256")
    .update(salt === 0 ? value : `${value}\0${salt}`)
    .digest("hex")
    .slice(0, QODER_TOOL_ALIAS_HASH_CHARS);
}

// Qoder collapses consecutive underscores in MCP tool names before emitting tool_use.
function directQoderAlias(wireName: string): string | undefined {
  return QODER_TOOL_ALIAS_PATTERN.test(wireName) &&
    !wireName.includes("__") &&
    wireName.length <= MAX_QODER_TOOL_ALIAS_CHARS
    ? wireName
    : undefined;
}

/**
 * Produce a deterministic MCP-safe alias while retaining a readable prefix.
 * `used` closes both normalization and truncated-hash collision domains.
 */
export function qoderToolAlias(
  wireName: string,
  used = new Set<string>(),
): string {
  const direct = directQoderAlias(wireName);
  if (direct && !used.has(direct)) {
    used.add(direct);
    return direct;
  }

  const cleaned = wireName.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  const maxBaseChars =
    MAX_QODER_TOOL_ALIAS_CHARS - QODER_TOOL_ALIAS_HASH_CHARS - 1;
  const base = cleaned.slice(0, maxBaseChars).replace(/_+$/g, "") || "tool";
  for (let salt = 0; salt <= QODER_TOOL_LIMITS.maxTools; salt++) {
    const candidate = `${base}_${shortHash(wireName, salt)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Qoder could not allocate a collision-free tool alias.");
}

/** Reserve direct names before hashing and sort the rest so request ordering cannot change aliases. */
function qoderToolAliases(
  wireNames: readonly string[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const wireName of wireNames) {
    const direct = directQoderAlias(wireName);
    if (direct) {
      aliases.set(wireName, direct);
      used.add(direct);
    }
  }
  const hashedNames = wireNames
    .filter((wireName) => !aliases.has(wireName))
    .sort();
  for (const wireName of hashedNames)
    aliases.set(wireName, qoderToolAlias(wireName, used));
  return aliases;
}

function requiresToolCall(choice: OcxToolChoice | undefined): boolean {
  return (
    choice === "required" ||
    (typeof choice === "object" &&
      choice !== null &&
      ("name" in choice || ("mode" in choice && choice.mode === "required")))
  );
}

function validateToolNamePart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasUnpairedSurrogate(value) &&
    !INVALID_TOOL_NAME_PATTERN.test(value)
  );
}

function prepareTool(
  tool: OcxTool,
  index: number,
  seenWireNames: Set<string>,
): PreparedTool {
  if (!tool || typeof tool !== "object")
    throw new Error(`Qoder tool ${index + 1} is not an object.`);
  if (
    !validateToolNamePart(tool.name) ||
    (tool.namespace !== undefined && !validateToolNamePart(tool.namespace))
  ) {
    throw new Error(
      `Qoder tool ${index + 1} has an invalid name or namespace.`,
    );
  }
  const wireName = namespacedToolName(tool.namespace, tool.name);
  if (utf8Bytes(wireName) > QODER_TOOL_LIMITS.maxNameBytes) {
    throw new Error(
      `Qoder tool ${index + 1} name exceeds ${QODER_TOOL_LIMITS.maxNameBytes} bytes.`,
    );
  }
  if (seenWireNames.has(wireName)) {
    throw new Error(
      `Qoder tool catalog contains a duplicate wire name: ${wireName}.`,
    );
  }
  seenWireNames.add(wireName);

  if (
    typeof tool.description !== "string" ||
    hasUnpairedSurrogate(tool.description) ||
    INVALID_DESCRIPTION_CONTROL_PATTERN.test(tool.description)
  ) {
    throw new Error(`Qoder tool ${index + 1} has an invalid description.`);
  }
  const description = tool.description || `Tool: ${wireName}`;
  if (utf8Bytes(description) > QODER_TOOL_LIMITS.maxDescriptionBytes) {
    throw new Error(
      `Qoder tool ${index + 1} description exceeds ${QODER_TOOL_LIMITS.maxDescriptionBytes} bytes.`,
    );
  }

  let inputSchema: Record<string, unknown>;
  let dialect: DialectDecision | undefined;
  try {
    const normalized = normalizeInputSchema(tool.parameters ?? {});
    inputSchema = normalized.inputSchema;
    dialect = normalized.dialect;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "unknown schema error";
    throw new Error(
      `Qoder tool ${index + 1} has an invalid input schema: ${detail}.`,
    );
  }
  return { source: tool, wireName, description, inputSchema, dialect };
}

function buildToolBridge(parsed: OcxParsedRequest): QoderToolBridge {
  const allTools = parsed.context.tools ?? [];
  if (!Array.isArray(allTools))
    throw new Error("Qoder tool catalog must be an array.");

  const choice = parsed.options.toolChoice;
  const requireToolCall = requiresToolCall(choice);
  // `none` is an authorization decision, so do not traverse or validate a
  // catalog that the nested CLI must never see. Besides avoiding needless
  // work, this prevents an unselected malformed or oversized definition from
  // turning an explicitly tool-free request into a local adapter failure.
  if (choice === "none") {
    return {
      tools: [],
      emittedNameMap: new Map(),
      requireToolCall: false,
      validateArguments: (_name: string) => "no tools are advertised for this turn",
    };
  }

  // Named and allowed-tools choices still need the complete identity view to
  // reject ambiguous shorthand, but schema/description/size validation belongs
  // only to definitions that can actually be advertised. `auto`/`required`
  // select the whole catalog and therefore retain the original full boundary.
  // Non-object entries have no selectable identity. Ignore them for a selective
  // choice; if the choice names nothing else, the required-choice check below
  // still fails closed. Unfiltered modes retain them so prepareTool rejects the
  // malformed catalog as before.
  const identityCatalog =
    typeof choice === "object" && choice !== null
      ? allTools.filter((tool) => tool !== null && typeof tool === "object")
      : allTools;
  const allows = toolChoiceToolPredicate(choice, identityCatalog);
  const selected = identityCatalog
    .map((tool, index) => ({ index, tool }))
    .filter(({ tool }) => allows(tool));
  if (requireToolCall && selected.length === 0) {
    throw new Error(
      "Qoder tool_choice requires a tool, but no matching tool is available.",
    );
  }
  if (selected.length > QODER_TOOL_LIMITS.maxTools) {
    throw new Error(
      `Qoder tool catalog exceeds the ${QODER_TOOL_LIMITS.maxTools}-tool limit.`,
    );
  }

  const seenWireNames = new Set<string>();
  const prepared = selected.map(({ index, tool }) =>
    prepareTool(tool, index, seenWireNames),
  );
  const aliases = qoderToolAliases(prepared.map((tool) => tool.wireName));
  // Compile each tool schema with a fresh, request-local AJV instance so no
  // rule set outlives its turn and schemas sharing an `$id` can never bleed
  // constraints into each other (F02).
  const compiledByAlias = new Map<string, CompiledSchema>();
  for (const tool of prepared) {
    const alias = aliases.get(tool.wireName)!;
    let compiled: CompiledSchema;
    try {
      compiled = compileSchemaWithDialect(tool.inputSchema, tool.dialect);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "unknown schema error";
      throw new Error(
        `Qoder tool ${prepared.indexOf(tool) + 1} has an invalid input schema: ${detail}.`,
      );
    }
    compiledByAlias.set(alias, compiled);
  }
  const definitions = prepared.map(
    (tool, index): QoderMcpToolDefinition => {
      const definition = {
        name: aliases.get(tool.wireName)!,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      if (serializedBytes(definition) > QODER_TOOL_LIMITS.maxToolBytes) {
        throw new Error(
          `Qoder tool ${index + 1} definition exceeds ${QODER_TOOL_LIMITS.maxToolBytes} bytes.`,
        );
      }
      return definition;
    },
  );
  if (serializedBytes(definitions) > QODER_TOOL_LIMITS.maxCatalogBytes) {
    throw new Error(
      `Qoder tool catalog exceeds ${QODER_TOOL_LIMITS.maxCatalogBytes} bytes.`,
    );
  }

  const emittedNameMap = new Map<string, string>();
  const tools = prepared.map((preparedTool, index) => {
    const definition = definitions[index];
    const emittedName = `${QODER_MCP_TOOL_PREFIX}${definition.name}`;
    if (emittedNameMap.has(emittedName)) {
      throw new Error(
        "Qoder tool catalog contains a colliding emitted alias.",
      );
    }
    emittedNameMap.set(emittedName, preparedTool.wireName);
    return definition;
  });

  const validateArguments = (
    name: string,
    args: Record<string, unknown>,
  ): string | undefined => {
    const compiled = compiledByAlias.get(name);
    if (!compiled) return `Unknown tool: ${name}.`;
    if (compiled.validate(args)) return undefined;
    return compiled.ajv.errorsText(compiled.validate.errors);
  };

  return { tools, emittedNameMap, requireToolCall, validateArguments };
}

export { buildToolBridge };
