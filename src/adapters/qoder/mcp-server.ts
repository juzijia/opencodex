/**
 * Isolated MCP catalog used by the Qoder adapter.
 *
 * This process advertises the current Codex tool schemas but deliberately never
 * executes a call. The parent adapter pairs this server's capture record with
 * Qoder's native `tool_use` identity, terminates the process tree, and returns the call to the host,
 * where the normal approval and sandbox boundary remains authoritative.
 */

import { open, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  QODER_TOOL_LIMITS,
  MAX_CAPTURE_BYTES,
  type ToolBridgeCapturePayload,
} from "./tool-bridge";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const INVALID_DESCRIPTION_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const textEncoder = new TextEncoder();
const VALIDATION_TIMEOUT_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
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

async function readCatalogBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error("tool catalog must be a regular file");
    if (before.size > QODER_TOOL_LIMITS.maxCatalogBytes) {
      throw new Error("tool catalog is too large");
    }

    // Read at most limit + 1 from the already-open descriptor. The extra byte
    // distinguishes an exact-limit file from a file that grew after fstat,
    // without ever allocating or retaining an attacker-sized input.
    const bytes = Buffer.allocUnsafe(QODER_TOOL_LIMITS.maxCatalogBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > QODER_TOOL_LIMITS.maxCatalogBytes) {
      throw new Error("tool catalog is too large");
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.size !== offset
    ) {
      throw new Error("tool catalog changed while being read");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertBoundedSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object")
    throw new Error("tool input schema must have object type");
  if (
    utf8Bytes(JSON.stringify(schema)) > QODER_TOOL_LIMITS.maxSchemaBytes
  ) {
    throw new Error("tool input schema is too large");
  }

  let nodes = 0;
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: schema },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > QODER_TOOL_LIMITS.maxSchemaNodes) {
      throw new Error("tool input schema has too many nodes");
    }
    if (current.depth > QODER_TOOL_LIMITS.maxSchemaDepth) {
      throw new Error("tool input schema is too deeply nested");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        pending.push({ depth: current.depth + 1, value: child });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
}

async function loadTools(path: string): Promise<ToolDefinition[]> {
  const bytes = await readCatalogBounded(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("tool catalog contains malformed JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("tool catalog must be an array");
  if (parsed.length > QODER_TOOL_LIMITS.maxTools) {
    throw new Error("tool catalog contains too many definitions");
  }

  const names = new Set<string>();
  return parsed.map((value): ToolDefinition => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      !MCP_TOOL_NAME_PATTERN.test(value.name) ||
      utf8Bytes(value.name) > QODER_TOOL_LIMITS.maxNameBytes ||
      typeof value.description !== "string" ||
      value.description.length < 1 ||
      hasUnpairedSurrogate(value.description) ||
      INVALID_DESCRIPTION_CONTROL_PATTERN.test(value.description) ||
      utf8Bytes(value.description) >
        QODER_TOOL_LIMITS.maxDescriptionBytes ||
      !isRecord(value.inputSchema)
    ) {
      throw new Error("tool catalog contains an invalid definition");
    }
    if (names.has(value.name))
      throw new Error("tool catalog contains duplicate names");
    names.add(value.name);
    assertBoundedSchema(value.inputSchema);
    const definition = {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
    if (
      utf8Bytes(JSON.stringify(definition)) > QODER_TOOL_LIMITS.maxToolBytes
    ) {
      throw new Error("tool catalog contains an oversized definition");
    }
    return definition;
  });
}

function compileToolValidator(schema: Record<string, unknown>): ValidateFunction {
  const uri = typeof schema.$schema === "string" ? schema.$schema.replace(/#+$/, "") : "";
  const options = { strict: false, validateSchema: false, allErrors: true, validateFormats: true };
  const ajv = /\/draft\/2020-12\/schema$/.test(uri)
    ? new Ajv2020(options)
    : /\/draft\/2019-09\/schema$/.test(uri)
      ? new Ajv2019(options)
      : !uri || /\/draft-07\/schema$/.test(uri)
        ? new Ajv(options)
        : undefined;
  if (!ajv) throw new Error("unsupported tool schema dialect");
  addFormats(ajv as Ajv);
  return ajv.compile(schema);
}

export async function runQoderMcpServer(catalogPath: string): Promise<void> {
  if (!catalogPath) throw new Error("missing tool catalog");

  // Exit when stdin closes. The MCP stdio binding expects servers to exit on stdin EOF, and the
  // pinned SDK (1.30.0) does not detect EOF itself: without this, the capture server would outlive
  // the CLI it serves — whenever the parent terminates the CLI (message_stop capture path, timeout,
  // crash), the pipe's write end closes, and this server must follow instead of lingering as an
  // orphaned bun process parked on the never-answering CallTool promise.
  const exitOnStdinClose = (): void => process.exit(0);
  process.stdin.on("end", exitOnStdinClose);
  process.stdin.on("close", exitOnStdinClose);

  const tools = await loadTools(catalogPath);
  const advertisedNames = new Set(tools.map((tool) => tool.name));
  const validators = new Map(tools.map(tool => [tool.name, compileToolValidator(tool.inputSchema)]));

  const server = new Server(
    { name: "opencodex-qoder-capture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  let callSequence = 0;
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!advertisedNames.has(request.params.name)) {
      return {
        isError: true,
        content: [{ type: "text", text: "unknown isolated tool" }],
      };
    }
    const captureDir = process.env.OCX_MCP_CAPTURE_DIR;
    const nonce = process.env.OCX_MCP_CAPTURE_NONCE;
    if (captureDir && nonce) {
      callSequence += 1;
      const payload: ToolBridgeCapturePayload = {
        version: 1,
        nonce,
        sequence: callSequence,
        name: request.params.name,
        arguments: (request.params.arguments as Record<string, unknown>) ?? {},
      };
      let payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
      if (payloadBytes.byteLength > MAX_CAPTURE_BYTES) {
        payloadBytes = Buffer.from(JSON.stringify({ ...payload, arguments: {}, error: "tool_call_limit" }), "utf8");
      } else {
        let valid = false;
        try {
          valid = runInNewContext("validate(input)", {
            validate: validators.get(request.params.name), input: payload.arguments,
          }, { timeout: VALIDATION_TIMEOUT_MS }) === true;
        } catch {
          // A timed-out or malformed validator never authorizes a host tool call.
        }
        if (!valid) {
          payloadBytes = Buffer.from(JSON.stringify({ ...payload, arguments: {}, error: "invalid_tool_arguments" }), "utf8");
        }
      }
      const targetFile = join(captureDir, `capture-${callSequence}.json`);
      const tmpFile = join(captureDir, `.${callSequence}.${randomUUID()}.tmp`);
      await writeFile(tmpFile, payloadBytes, { mode: 0o600 });
      await rename(tmpFile, targetFile);
    }
    // A pending Promise does not execute anything and keeps the vendor turn
    // parked until the parent has captured the call and terminates the tree.
    return await new Promise<never>(() => {});
  });

  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await runQoderMcpServer(process.argv[2] ?? "");
