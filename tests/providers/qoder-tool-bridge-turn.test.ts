import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  createQoderAdapter,
  type SpawnFn,
} from "../../src/adapters/qoder/adapter";
import { buildToolBridge as buildQoderToolBridge } from "../../src/adapters/coding-agent/tool-bridge";
import {
  QODER_GLOBAL_PROFILE,
  clearQoderBinaryCache,
} from "../../src/adapters/qoder/profiles";
import type {
  AdapterEvent,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTool,
} from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => clearQoderBinaryCache());

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

function fakeChild(stdout: Uint8Array[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from([]);
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("close", 0);
    }, 5);
    return true;
  };
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      child.exitCode = 0;
      child.emit("close", 0);
    }
  }, 50);
  return child;
}

function tool(name: string): OcxTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: { a: { type: "number" } } },
  };
}

function parsed(tools: OcxTool[] = []): OcxParsedRequest {
  return {
    modelId: "Qwen3.8-Flash",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Use a tool", timestamp: 1 }],
      ...(tools.length > 0 ? { tools } : {}),
    },
  } as OcxParsedRequest;
}

function provider(): OcxProviderConfig {
  return {
    adapter: "qoder",
    baseUrl: QODER_GLOBAL_PROFILE.canonicalBaseUrl,
    apiKey: "qoder-pat",
    reasoningEfforts: ["low", "high", "xhigh", "max"],
  } as OcxProviderConfig;
}

function incoming() {
  return {
    headers: new Headers(),
    translatorBudget: createTestTranslatorBudget(),
  };
}

async function run(
  adapter: ReturnType<typeof createQoderAdapter>,
  p: OcxParsedRequest,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), (e) => events.push(e));
  return events;
}

function frameLines(frames: unknown[]): Uint8Array[] {
  return frames.map((f) => enc.encode(JSON.stringify(f) + "\n"));
}

const INIT_OK = {
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "opencodex", status: "connected" }],
};
const INIT_EMPTY = { type: "system", subtype: "init", mcp_servers: [] };

function toolUseStart(name: string, id = "tu_1"): unknown {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", id, name },
    },
  };
}
function inputJsonDelta(part: string): unknown {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: part },
    },
  };
}
const BLOCK_STOP = {
  type: "stream_event",
  event: { type: "content_block_stop" },
};
const MESSAGE_STOP = { type: "stream_event", event: { type: "message_stop" } };

describe("Qoder capture-only tool bridge turn", () => {
  test("advertises the catalog, captures the call, renames it, and ends the leg at message_stop", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;

    let child: FakeChild | undefined;
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      child = fakeChild(
        frameLines([
          INIT_OK,
          toolUseStart(cliName),
          inputJsonDelta('{"a":'),
          inputJsonDelta("1}"),
          BLOCK_STOP,
          MESSAGE_STOP,
          // Deliberately no result frame: in production the CLI parks on the
          // never-answering capture server after message_stop.
        ]),
      );
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);

    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    const allowedIdx = seenArgs.indexOf("--allowed-tools");
    expect(allowedIdx).toBeGreaterThanOrEqual(0);
    expect(seenArgs[allowedIdx + 1]).toBe(cliName);
    const mcpIdx = seenArgs.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(seenArgs[mcpIdx + 1]).toContain("ocx-coding-agent-tools-");
    // The private temp dir is removed once the turn settles.
    expect(existsSync(dirname(seenArgs[mcpIdx + 1]!))).toBe(false);

    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_call_start",
      name: wireName,
    });
    expect(events[4]).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
    });
    expect(child?.killed).toBe(true);
  });

  test("a request without tools keeps the text-only arg shape", async () => {
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      return fakeChild([
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]) as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, parsed());
    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowed-tools");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("a tool-bridge turn reports the partial usage observed before message_stop", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) =>
      fakeChild(
        frameLines([
          INIT_OK,
          {
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { input_tokens: 12, output_tokens: 5 },
            },
          },
          toolUseStart(cliName),
          inputJsonDelta("{}"),
          BLOCK_STOP,
          {
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: {},
              usage: {
                input_tokens: 15,
                output_tokens: 4,
                cache_read_input_tokens: 3,
              },
            },
          },
          MESSAGE_STOP,
          // No result frame: the CLI parks on the never-answering capture server after message_stop.
        ]),
      ) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage: {
        inputTokens: 15,
        outputTokens: 5,
        totalTokens: 20,
        cachedInputTokens: 3,
        cacheReadInputTokens: 3,
      },
    });
  });

  test("a tool-bridge turn records input tokens from message_start", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) =>
      fakeChild(
        frameLines([
          INIT_OK,
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { usage: { input_tokens: 31, output_tokens: 0 } },
            },
          },
          toolUseStart(cliName),
          inputJsonDelta("{}"),
          BLOCK_STOP,
          {
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: {},
              usage: { input_tokens: 31, output_tokens: 6 },
            },
          },
          MESSAGE_STOP,
        ]),
      ) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 31, outputTokens: 6, totalTokens: 37 },
    });
  });

  test("message_stop with an incomplete tool call fails with protocol_error", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) =>
      fakeChild(
        frameLines([
          INIT_OK,
          toolUseStart(cliName),
          inputJsonDelta("{}"),
          // Missing BLOCK_STOP (tool_call_end not emitted, so toolCallStarts=1, completedToolCalls=0)
          MESSAGE_STOP,
        ]),
      ) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
      retryable: false,
    });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("tool_choice required without a captured call fails closed instead of a text done", async () => {
    const p = parsed([tool("exec")]);
    p.options = { toolChoice: "required" } as OcxParsedRequest["options"];
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild([
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_call_required",
      status: 502,
      retryable: false,
    });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("tool_choice auto keeps a text-only result as a normal done", async () => {
    const p = parsed([tool("exec")]);
    const spawn: SpawnFn = () =>
      fakeChild([
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("a synchronous spawn throw still removes the private temp dir", async () => {
    const p = parsed([tool("exec")]);
    // Diff-based so a concurrently running proxy's own bridge dirs can never flake this.
    const before = new Set(
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith("ocx-coding-agent-tools-"),
      ),
    );
    const spawn: SpawnFn = () => {
      throw new Error("spawn exploded");
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events[0]).toMatchObject({
      type: "error",
      code: "cli_spawn_failed",
    });
    const leftovers = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("ocx-coding-agent-tools-") && !before.has(name),
    );
    expect(leftovers).toEqual([]);
  });

  test("an init frame without the bridge server fails closed", async () => {
    const adapter = createQoderAdapter(provider(), {
      spawn: () =>
        fakeChild(frameLines([INIT_EMPTY])) as unknown as ChildProcess,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(events[0]).toMatchObject({
      type: "error",
      code: "tool_bridge_init_mismatch",
      retryable: false,
    });
  });

  test("a tool call outside the advertised catalog fails closed", async () => {
    const adapter = createQoderAdapter(provider(), {
      spawn: () =>
        fakeChild(
          frameLines([
            INIT_OK,
            toolUseStart("mcp__opencodex__evil"),
            inputJsonDelta("{}"),
            BLOCK_STOP,
            MESSAGE_STOP,
          ]),
        ) as unknown as ChildProcess,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(events[0]).toMatchObject({
      type: "error",
      code: "undeclared_tool_call",
      retryable: false,
    });
  });

  test("more captured calls than the turn limit fails closed", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const frames: unknown[] = [INIT_OK];
    for (let i = 0; i < 17; i += 1) {
      frames.push(toolUseStart(cliName, `tu_${i}`));
      frames.push(BLOCK_STOP);
    }
    frames.push(MESSAGE_STOP);
    const adapter = createQoderAdapter(provider(), {
      spawn: () => fakeChild(frameLines(frames)) as unknown as ChildProcess,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_call_limit",
    });
  });

  test("continuation turn projects toolResult correctly and runs text leg", async () => {
    const continuationRequest: OcxParsedRequest = {
      modelId: "Qwen3.8-Flash",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: "Run bash", timestamp: 1 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "Bash",
                arguments: { command: "ls" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: "file1.txt\nfile2.txt",
            isError: false,
          },
        ],
      },
    } as OcxParsedRequest;
    let stdinCaptured = "";
    const spawn: SpawnFn = () => {
      const child = fakeChild([
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]) as unknown as ChildProcess;
      child.stdin = new Writable({
        write(chunk, _encoding, cb) {
          stdinCaptured += chunk.toString();
          cb();
        },
      });
      return child;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, continuationRequest);
    expect(stdinCaptured).toContain("TOOL RESULT (call_id: call_1)");
    expect(stdinCaptured).toContain("file1.txt");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("deadlock regression: side-channel capture completes turn even when stdout never emits message_stop", async () => {
    const p = parsed([tool("Bash")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    let capturedToolBridgeDir: string | undefined;
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, args) => {
      const mcpIdx = args.indexOf("--mcp-config");
      let actualNonce = "";
      if (mcpIdx >= 0) {
        const mcpConfigPath = args[mcpIdx + 1]!;
        capturedToolBridgeDir = dirname(mcpConfigPath);
        const { readFileSync } = require("node:fs");
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
        actualNonce = mcpConfig.mcpServers.opencodex.env.OCX_MCP_CAPTURE_NONCE;
      }
      child = new EventEmitter() as FakeChild;
      child.stdout = new Readable({ read() {} });
      child.stderr = Readable.from([]);
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        }, 5);
        return true;
      };
      if (capturedToolBridgeDir && actualNonce) {
        const { writeFileSync, renameSync } = require("node:fs");
        const payload = {
          version: 1,
          nonce: actualNonce,
          sequence: 1,
          name: "Bash",
          arguments: { command: "printf 'OK\\n'" },
        };
        const tmp = join(capturedToolBridgeDir, ".capture-1.tmp");
        const target = join(capturedToolBridgeDir, "capture-1.json");
        writeFileSync(tmp, JSON.stringify(payload), "utf8");
        renameSync(tmp, target);
      }
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "Bash" });
    const startId = (events[0] as { id: string }).id;
    expect(startId).toMatch(/^call_[a-zA-Z0-9_-]+$/);
    expect(events[1]).toMatchObject({
      type: "tool_call_delta",
      arguments: JSON.stringify({ command: "printf 'OK\\n'" }),
    });
    expect(events[3]).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
    });
    expect(child?.killed).toBe(true);
  });

  function strictBashTool(): OcxTool {
    return {
      name: "Bash",
      description: "Run a bash command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    };
  }

  async function runSideChannelCapture(
    toolDef: OcxTool,
    payloadOverrides: Record<string, unknown> = {},
    options: {
      filename?: string;
      rawContent?: string;
      stdoutFrames?: unknown[];
    } = {},
  ): Promise<{ events: AdapterEvent[]; child?: FakeChild }> {
    const p = parsed([toolDef]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, args) => {
      const mcpIdx = args.indexOf("--mcp-config");
      let actualNonce = "";
      let capturedToolBridgeDir = "";
      if (mcpIdx >= 0) {
        const mcpConfigPath = args[mcpIdx + 1]!;
        capturedToolBridgeDir = dirname(mcpConfigPath);
        const { readFileSync } = require("node:fs");
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
        actualNonce = mcpConfig.mcpServers.opencodex.env.OCX_MCP_CAPTURE_NONCE;
      }
      child = new EventEmitter() as FakeChild;
      child.stdout = options.stdoutFrames
        ? Readable.from(frameLines(options.stdoutFrames))
        : new Readable({ read() {} });
      child.stderr = Readable.from([]);
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        }, 5);
        return true;
      };
      if (capturedToolBridgeDir) {
        const { writeFileSync, renameSync } = require("node:fs");
        const filename = options.filename ?? "capture-1.json";
        const tmp = join(capturedToolBridgeDir, `.${filename}.tmp`);
        const target = join(capturedToolBridgeDir, filename);
        let content = options.rawContent;
        if (content === undefined) {
          const payload = {
            version: 1,
            nonce: actualNonce,
            sequence: 1,
            name: toolDef.name,
            arguments: { command: "ls -la" },
            ...payloadOverrides,
          };
          content = JSON.stringify(payload);
        }
        writeFileSync(tmp, content, "utf8");
        renameSync(tmp, target);
      }
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    return { events, child };
  }

  test("valid Bash args PASS schema validation", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      arguments: { command: "ls -la" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "Bash" });
    expect(events[1]).toMatchObject({
      type: "tool_call_delta",
      arguments: JSON.stringify({ command: "ls -la" }),
    });
    expect(events[3]).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
    });
  });

  test("missing required args FAIL CLOSED without emitting ToolCall", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      arguments: {},
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_tool_arguments",
      status: 502,
    });
  });

  test("wrong type args FAIL CLOSED without emitting ToolCall", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      arguments: { command: 123 },
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_tool_arguments",
      status: 502,
    });
  });

  test("additionalProperties:false extra field FAIL CLOSED without emitting ToolCall", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      arguments: { command: "ls -la", extra: "forbidden" },
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "invalid_tool_arguments",
      status: 502,
    });
  });

  test("sequence 1 PASS", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      sequence: 1,
    });
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "Bash" });
  });

  test("sequence 0 FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { sequence: 0 },
      { filename: "capture-0.json" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("sequence -1 FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { sequence: -1 },
      { filename: "capture--1.json" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("sequence 2 FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { sequence: 2 },
      { filename: "capture-2.json" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("non-integer sequence FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { sequence: 1.5 },
      { filename: "capture-1.json" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("filename/payload sequence mismatch FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { sequence: 1 },
      { filename: "capture-2.json" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("malformed capture record FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      {},
      { rawContent: "invalid json string {" },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
    });
  });

  test("oversized capture record FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      {},
      { rawContent: "x".repeat(256 * 1024 + 1) },
    );
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_call_limit",
      status: 502,
    });
  });

  test("nonce mismatch FAIL CLOSED", async () => {
    const { events } = await runSideChannelCapture(strictBashTool(), {
      nonce: "wrong-nonce-12345",
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_bridge_init_mismatch",
      status: 502,
    });
  });

  test("stdout/capture dedup PASS: stdout message_stop does not emit duplicate tool_use or done after capture", async () => {
    const p = parsed([strictBashTool()]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const { events } = await runSideChannelCapture(
      strictBashTool(),
      { arguments: { command: "ls" } },
      {
        stdoutFrames: [
          INIT_OK,
          toolUseStart(cliName),
          inputJsonDelta('{"command":"ls"}'),
          BLOCK_STOP,
          MESSAGE_STOP,
        ],
      },
    );
    // Even though stdout also had tool_use frames, only one tool call sequence is emitted
    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
  });

  test("abort race PASS: aborting during side-channel capture cleanly halts turn", async () => {
    const p = parsed([strictBashTool()]);
    const abortController = new AbortController();
    abortController.abort();
    const adapter = createQoderAdapter(provider(), {
      spawn: () => fakeChild([]) as unknown as ChildProcess,
      which: () => "/usr/bin/qoder",
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      p,
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), abortSignal: abortController.signal },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: "Coding-agent turn was aborted before start.",
    });
  });

  test("real alias/name mapping PASS: aliased tool names map back to original wire names", async () => {
    const aliasedTool: OcxTool = {
      name: "very_long_tool_name_that_exceeds_the_forty_character_alias_limit_by_a_wide_margin",
      description: "A tool with a long name",
      parameters: { type: "object", properties: { x: { type: "string" } } },
    };
    const p = parsed([aliasedTool]);
    const bridge = buildQoderToolBridge(p);
    const mcpTool = bridge.tools[0]!;
    expect(mcpTool.name).not.toBe(aliasedTool.name);

    let capturedToolBridgeDir: string | undefined;
    let actualNonce = "";
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, args) => {
      const mcpIdx = args.indexOf("--mcp-config");
      if (mcpIdx >= 0) {
        const mcpConfigPath = args[mcpIdx + 1]!;
        capturedToolBridgeDir = dirname(mcpConfigPath);
        const { readFileSync } = require("node:fs");
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
        actualNonce = mcpConfig.mcpServers.opencodex.env.OCX_MCP_CAPTURE_NONCE;
      }
      child = new EventEmitter() as FakeChild;
      child.stdout = new Readable({ read() {} });
      child.stderr = Readable.from([]);
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 5);
        return true;
      };
      if (capturedToolBridgeDir && actualNonce) {
        const { writeFileSync, renameSync } = require("node:fs");
        const payload = {
          version: 1,
          nonce: actualNonce,
          sequence: 1,
          name: mcpTool.name, // MCP server uses the alias name
          arguments: { x: "test" },
        };
        const tmp = join(capturedToolBridgeDir, ".capture-1.tmp");
        const target = join(capturedToolBridgeDir, "capture-1.json");
        writeFileSync(tmp, JSON.stringify(payload), "utf8");
        renameSync(tmp, target);
      }
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_call_start",
      name: aliasedTool.name, // Parent maps alias back to original wire name
    });
  });
});
