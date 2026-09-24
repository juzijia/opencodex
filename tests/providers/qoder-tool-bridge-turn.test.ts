import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  createQoderAdapter,
  type SpawnFn,
} from "../../src/adapters/qoder/adapter";
import { buildToolBridge as buildQoderToolBridge } from "../../src/adapters/qoder/tool-bridge";
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

function parsed(
  tools: OcxTool[] = [],
  overrides: Partial<OcxParsedRequest> = {},
): OcxParsedRequest {
  const contextOverrides = overrides.context ?? {};
  const { context: _c, ...restOverrides } = overrides;
  const effectiveTools =
    "tools" in contextOverrides
      ? contextOverrides.tools
      : tools.length > 0
        ? tools
        : undefined;
  return {
    modelId: "Qwen3.8-Flash",
    stream: true,
    options: {},
    ...restOverrides,
    context: {
      messages: [{ role: "user", content: "Use a tool", timestamp: 1 }],
      ...contextOverrides,
      ...(effectiveTools ? { tools: effectiveTools } : {}),
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

describe("Qoder bridge remediation", () => {
  function capturedAdapter(p: OcxParsedRequest, frames: (name: string) => unknown[]) {
    const bridge = buildQoderToolBridge(p);
    return createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, bridge.tools[0]!.name, { a: 1 });
        return fakeChild(frameLines(frames([...bridge.emittedNameMap.keys()][0]!))) as unknown as ChildProcess;
      },
    });
  }

  test.each(["auto", { name: "mcp__alpha__lookup" }] as const)("accepts namespaced capture with choice %j", async choice => {
    const p = parsed([{ ...tool("lookup"), namespace: "mcp__alpha" }]);
    p.options.toolChoice = choice;
    const events = await run(capturedAdapter(p, name => [INIT_OK, toolUseStart(name), BLOCK_STOP, MESSAGE_STOP]), p);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "mcp__alpha__lookup" });
    expect(events.at(-1)?.type).toBe("done");
  });

  test("commits a Qoder complete assistant tool_use when no partial tool frame arrives", async () => {
    const p = parsed([tool("lookup")]);
    const events = await run(capturedAdapter(p, name => [
      INIT_OK,
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "toolu_complete_1", name, input: { a: 1 } },
      ] } },
    ]), p);
    expect(events.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    expect(events[0]).toMatchObject({ id: "toolu_complete_1", name: "lookup" });
    expect(events.at(-1)).toMatchObject({ stopReason: "tool_use", endTurn: false });
  });

  test("does not count a complete assistant copy of a streamed tool_use twice", async () => {
    const p = parsed([tool("lookup")]);
    const events = await run(capturedAdapter(p, name => [
      INIT_OK,
      toolUseStart(name, "toolu_streamed_1"),
      BLOCK_STOP,
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "toolu_streamed_1", name, input: { a: 1 } },
      ] } },
      MESSAGE_STOP,
    ]), p);
    expect(events.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    expect(events[0]).toMatchObject({ id: "toolu_streamed_1", name: "lookup" });
  });

  test("requires a verified init before side-channel success", async () => {
    const p = parsed([tool("lookup")]);
    const events = await run(capturedAdapter(p, name => [toolUseStart(name), BLOCK_STOP, MESSAGE_STOP]), p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_bridge_init_missing" });
  });

  test("drains usage after tool start before committing", async () => {
    const p = parsed([tool("lookup")]);
    const events = await run(capturedAdapter(p, name => [
      INIT_OK,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 100 } } } },
      toolUseStart(name), BLOCK_STOP,
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 30 } } },
      MESSAGE_STOP,
    ]), p);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } });
  });

  test("ignores extra captures arriving together after init", async () => {
    const p = parsed([tool("lookup")]);
    const bridge = buildQoderToolBridge(p);
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        const child = fakeChild([]);
        child.stdout = Readable.from((async function* () {
          yield frameLines([INIT_OK])[0]!;
          await Bun.sleep(20);
          writeCaptureFile(captureDir, nonce, 1, bridge.tools[0]!.name, { a: 1 });
          writeCaptureFile(captureDir, nonce, 2, bridge.tools[0]!.name, { a: 2 });
          yield* frameLines([toolUseStart([...bridge.emittedNameMap.keys()][0]!), inputJsonDelta('{"a":1}'), BLOCK_STOP, MESSAGE_STOP]);
        })());
        return child as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.filter(e => e.type === "tool_call_start")).toHaveLength(1);
    expect(events.find(e => e.type === "tool_call_delta")).toMatchObject({ arguments: '{"a":1}' });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  test("does not spawn after cancellation during temporary-file preparation", async () => {
    const controller = new AbortController();
    let spawns = 0;
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: () => { spawns++; return fakeChild([]) as unknown as ChildProcess; },
    });
    const events: AdapterEvent[] = [];
    queueMicrotask(() => controller.abort());
    await adapter.runTurn!(parsed([tool("lookup")]), { ...incoming(), abortSignal: controller.signal }, e => events.push(e));
    expect(spawns).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
  });
});

function captureConfig(args: readonly string[]): {
  captureDir: string;
  nonce: string;
} {
  const mcpIdx = args.indexOf("--mcp-config");
  expect(mcpIdx).toBeGreaterThanOrEqual(0);
  const config = JSON.parse(readFileSync(args[mcpIdx + 1]!, "utf8"));
  const env = config.mcpServers.opencodex.env;
  return {
    captureDir: env.OCX_MCP_CAPTURE_DIR as string,
    nonce: env.OCX_MCP_CAPTURE_NONCE as string,
  };
}

function writeCaptureFile(
  captureDir: string,
  nonce: string,
  sequence: number,
  name: string,
  callArgs: Record<string, unknown>,
): void {
  const payload = { version: 1, nonce, sequence, name, arguments: callArgs };
  const tmpFile = join(captureDir, `.test-${sequence}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(payload), "utf8");
  renameSync(tmpFile, join(captureDir, `capture-${sequence}.json`));
}

describe("Qoder capture-only tool bridge turn", () => {
  test("advertises the catalog and commits the native call without waiting for message_stop", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;

    let child: FakeChild | undefined;
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, bridge.tools[0]!.name, { a: 1 });
      child = fakeChild(
        frameLines([
          INIT_OK,
          toolUseStart(cliName),
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
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_call_start",
      id: "tu_1",
      name: wireName,
    });
    expect(events[3]).toMatchObject({
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

  test("a tool-bridge turn reports partial usage observed before side-channel commit", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, bridge.tools[0]!.name, { a: 1 });
      return fakeChild(
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
        ]),
      ) as unknown as ChildProcess;
    };
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
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        estimated: true,
      },
    });
  });

  test("a tool-bridge turn records input tokens from message_start", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, bridge.tools[0]!.name, { a: 1 });
      return fakeChild(
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
        ]),
      ) as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 31, estimated: true },
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
        enc.encode(JSON.stringify(INIT_OK) + "\n"),
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
        enc.encode(JSON.stringify(INIT_OK) + "\n"),
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("rejects a text-only result when the MCP init frame is missing", async () => {
    const p = parsed([tool("exec")]);
    const adapter = createQoderAdapter(provider(), {
      spawn: () => fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_bridge_init_missing" });
    expect(events.some(e => e.type === "done")).toBe(false);
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

  test("a second native tool start fails closed", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const frames: unknown[] = [INIT_OK];
    for (let i = 0; i < 2; i += 1) {
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
      code: "protocol_error",
    });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
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

});

describe("Qoder side-channel capture", () => {
  function manualChild(): {
    child: FakeChild;
    push: (frame: unknown | null) => void;
  } {
    const child = new EventEmitter() as FakeChild;
    const out = new Readable({ read() {} });
    child.stdout = out;
    child.stderr = Readable.from([]);
    child.stdin = new Writable({
      write(_chunk, _encoding, cb) {
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
    const push = (frame: unknown | null): void => {
      if (frame === null) {
        out.push(null);
        setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            child.exitCode = 0;
            child.emit("close", 0);
          }
        }, 10);
        return;
      }
      out.push(enc.encode(JSON.stringify(frame) + "\n"));
    };
    return { child, push };
  }

  function sideChannelCase(): {
    p: OcxParsedRequest;
    cliName: string;
    wireName: string;
    alias: string;
  } {
    const p = parsed([tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;
    const alias = bridge.tools[0]!.name;
    return { p, cliName, wireName, alias };
  }

  function expectSingleCapturedCall(
    events: AdapterEvent[],
    nativeId: string,
    wireName: string,
  ): void {
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_call_start",
      id: nativeId,
      name: wireName,
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
    });
  }

  test("capture arrives first, native id later: waits and emits once with native id", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
      const { child, push } = manualChild();
      setTimeout(() => {
        push(INIT_OK);
        push(toolUseStart(cliName, "tu_native_9"));
        push(null);
      }, 100);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expectSingleCapturedCall(events, "tu_native_9", wireName);
  });

  test("native id arrives first, capture later: emits once", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_first_1"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      setTimeout(
        () => writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 }),
        120,
      );
      setTimeout(() => push(null), 200);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expectSingleCapturedCall(events, "tu_first_1", wireName);
  });

  test("parallel CLI calls fail closed instead of publishing the first tool", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 2 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_first"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      push(toolUseStart(cliName, "tu_second"));
      push(inputJsonDelta('{"a":2}'));
      push(BLOCK_STOP);
      push(MESSAGE_STOP);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("reversed same-tool captures with two native calls fail closed", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_first"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      push(toolUseStart(cliName, "tu_second"));
      push(inputJsonDelta('{"a":2}'));
      push(BLOCK_STOP);
      push(MESSAGE_STOP);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("reversed different-tool captures with two native calls fail closed", async () => {
    const p = parsed([tool("lookup"), tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const lookup = [...bridge.emittedNameMap.entries()].find(([, wire]) => wire === "lookup")!;
    const exec = [...bridge.emittedNameMap.entries()].find(([, wire]) => wire === "exec")!;
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, bridge.tools.find(t => exec[0].endsWith(t.name))!.name, { a: 2 });
      writeCaptureFile(captureDir, nonce, 2, bridge.tools.find(t => lookup[0].endsWith(t.name))!.name, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(lookup[0], "tu_lookup"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      push(toolUseStart(exec[0], "tu_exec"));
      push(inputJsonDelta('{"a":2}'));
      push(BLOCK_STOP);
      push(MESSAGE_STOP);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("waits for the matching reversed capture after an earlier unrelated capture", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_first"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      push(MESSAGE_STOP);
      setTimeout(() => {
        if (existsSync(captureDir)) writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      }, 120);
      setTimeout(() => push(null), 200);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), { spawn, which: () => "/usr/bin/qoder" });
    const events = await run(adapter, p);
    expectSingleCapturedCall(events, "tu_first", wireName);
    expect(events[1]).toMatchObject({ type: "tool_call_delta", arguments: '{"a":1}' });
  });

  test("parallel captures without native input fail closed instead of guessing by sequence", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_first"));
      push(BLOCK_STOP);
      push(toolUseStart(cliName, "tu_second"));
      push(BLOCK_STOP);
      push(MESSAGE_STOP);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("a lone capture with the wrong tool name cannot supply missing native input", async () => {
    const p = parsed([tool("lookup"), tool("exec")]);
    const bridge = buildQoderToolBridge(p);
    const lookup = [...bridge.emittedNameMap.entries()].find(([, wire]) => wire === "lookup")!;
    const execAlias = bridge.tools.find(t => [...bridge.emittedNameMap.entries()].some(([name, wire]) => wire === "exec" && name.endsWith(t.name)))!.name;
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, execAlias, { a: 2 });
      return fakeChild(frameLines([INIT_OK, toolUseStart(lookup[0], "tu_lookup"), BLOCK_STOP, MESSAGE_STOP])) as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), { spawn, which: () => "/usr/bin/qoder" });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("complete assistant with two native calls fails closed without partial deltas", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      return fakeChild(frameLines([
        INIT_OK,
        { type: "assistant", message: { role: "assistant", content: [
          { type: "tool_use", id: "tu_first", name: cliName, input: { a: 1 } },
          { type: "tool_use", id: "tu_second", name: cliName, input: { a: 2 } },
        ] } },
      ])) as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("complete assistant input can arrive after message_stop", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      return fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName, "tu_first"),
        BLOCK_STOP,
        MESSAGE_STOP,
        { type: "assistant", message: { role: "assistant", content: [
          { type: "tool_use", id: "tu_first", name: cliName, input: { a: 1 } },
        ] } },
      ])) as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), { spawn, which: () => "/usr/bin/qoder" });
    const events = await run(adapter, p);
    expectSingleCapturedCall(events, "tu_first", wireName);
    expect(events[1]).toMatchObject({ type: "tool_call_delta", arguments: '{"a":1}' });
  });

  test("native id never arrives: fails closed without synthetic id", async () => {
    const { p, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/call_[0-9a-f]{24}/);
  });

  test("sequence=2 capture fails closed", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 2, alias, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_seq_2"));
      push(inputJsonDelta('{"a":1}'));
      push(BLOCK_STOP);
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
  });

  test("successful capture emits exactly one terminal and no trailing error", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const spawn: SpawnFn = (_cmd, args) => {
      const { captureDir, nonce } = captureConfig(args);
      writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
      const { child, push } = manualChild();
      push(INIT_OK);
      push(toolUseStart(cliName, "tu_once_1"));
      push(null);
      return child as unknown as ChildProcess;
    };
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expectSingleCapturedCall(events, "tu_once_1", wireName);
  });

  test("duplicate native tool IDs fail closed instead of taking the later input", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        writeCaptureFile(captureDir, nonce, 2, alias, { a: 2 });
        return fakeChild(frameLines([INIT_OK, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "same_id", name: cliName, input: { a: 1 } },
            { type: "tool_use", id: "same_id", name: cliName, input: { a: 2 } },
          ] },
        }, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("duplicate raw native IDs in one assistant message fail closed", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        const first = toolUseStart(cliName, "raw_duplicate") as { event: { content_block: Record<string, unknown> } };
        first.event.content_block.input = { a: 1 };
        const second = toolUseStart(cliName, "raw_duplicate") as { event: { content_block: Record<string, unknown> } };
        second.event.content_block.input = { a: 2 };
        return fakeChild(frameLines([INIT_OK, first, BLOCK_STOP, second, BLOCK_STOP, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("a streamed native call cannot commit before its assistant frame reveals a duplicate ID", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        const rawStart = toolUseStart(cliName, "repeated_id") as { event: { content_block: Record<string, unknown> } };
        rawStart.event.content_block.input = { a: 1 };
        return fakeChild(frameLines([INIT_OK, rawStart, BLOCK_STOP, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "repeated_id", name: cliName, input: { a: 1 } },
            { type: "tool_use", id: "repeated_id", name: cliName, input: { a: 2 } },
          ] },
        }, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("raw native input must agree with the capture", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 2 });
        const rawStart = toolUseStart(cliName, "raw_input") as { event: { content_block: Record<string, unknown> } };
        rawStart.event.content_block.input = { a: 1 };
        return fakeChild(frameLines([INIT_OK, rawStart, BLOCK_STOP, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("an empty raw input placeholder can be completed by JSON deltas", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        const rawStart = toolUseStart(cliName, "raw_placeholder") as { event: { content_block: Record<string, unknown> } };
        rawStart.event.content_block.input = {};
        return fakeChild(frameLines([INIT_OK, rawStart, inputJsonDelta('{"a":1}'),
          BLOCK_STOP, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    expectSingleCapturedCall(await run(adapter, p), "raw_placeholder", wireName);
  });

  test("message_stop cannot commit an absent input before a conflicting complete assistant arrives", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        return fakeChild(frameLines([INIT_OK, toolUseStart(cliName, "late_input"), BLOCK_STOP,
          MESSAGE_STOP, { type: "assistant", message: { content: [
            { type: "tool_use", id: "late_input", name: cliName, input: { a: 2 } },
          ] } },
        ])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test.each([{ label: "array", input: [] }, { label: "null", input: null }])("invalid present native $label input cannot fall back to capture", async ({ input: invalidInput }) => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        return fakeChild(frameLines([INIT_OK, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "invalid_input", name: cliName, input: invalidInput },
          ] },
        }, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("an immediate result settles a complete native and MCP capture", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        return fakeChild(frameLines([INIT_OK, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "immediate_result", name: cliName, input: { a: 1 } },
          ] },
        }, MESSAGE_STOP, { type: "result", subtype: "success" }])) as unknown as ChildProcess;
      },
    });
    expectSingleCapturedCall(await run(adapter, p), "immediate_result", wireName);
  });

  test("an absent-input assistant settles after result, message_stop, and EOF", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        return fakeChild(frameLines([INIT_OK, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "result_before_stop", name: cliName },
          ] },
        }, { type: "result", subtype: "success" }, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    expectSingleCapturedCall(await run(adapter, p), "result_before_stop", wireName);
  });

  test("an immediate result waits for a late matching capture within the final bound", async () => {
    const { p, cliName, wireName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        const { child, push } = manualChild();
        push(INIT_OK);
        push({ type: "assistant", message: { content: [
          { type: "tool_use", id: "late_capture", name: cliName, input: { a: 1 } },
        ] } });
        push({ type: "result", subtype: "success" });
        setTimeout(() => {
          if (existsSync(captureDir)) writeCaptureFile(captureDir, nonce, 1, alias, { a: 1 });
        }, 120);
        return child as unknown as ChildProcess;
      },
    });
    expectSingleCapturedCall(await run(adapter, p), "late_capture", wireName);
  });

  test("a helper validation rejection fails closed without emitting a host tool call", async () => {
    const { p, cliName, alias } = sideChannelCase();
    const adapter = createQoderAdapter(provider(), {
      which: () => "/usr/bin/qoder",
      spawn: (_cmd, args) => {
        const { captureDir, nonce } = captureConfig(args);
        writeFileSync(join(captureDir, "capture-1.json"), JSON.stringify({
          version: 1, nonce, sequence: 1, name: alias, arguments: {}, error: "invalid_tool_arguments",
        }));
        return fakeChild(frameLines([INIT_OK, {
          type: "assistant", message: { content: [
            { type: "tool_use", id: "rejected_input", name: cliName, input: { a: 1 } },
          ] },
        }, MESSAGE_STOP])) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "invalid_tool_arguments" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  });

  test("required-tool error message is provider-neutral", async () => {
    const { p } = sideChannelCase();
    p.options = { toolChoice: "required" } as OcxParsedRequest["options"];
    const spawn: SpawnFn = () =>
      fakeChild([
        enc.encode(JSON.stringify(INIT_OK) + "\n"),
        enc.encode('{"type":"result","subtype":"success"}\n'),
      ]) as unknown as ChildProcess;
    const adapter = createQoderAdapter(provider(), {
      spawn,
      which: () => "/usr/bin/qoder",
    });
    const events = await run(adapter, p);
    const last = events.at(-1)! as { message?: unknown };
    expect(last).toMatchObject({ type: "error", code: "tool_call_required" });
    const message = String(last.message ?? JSON.stringify(last));
    expect(message).toContain("Qoder");
    expect(message).not.toContain("CodeBuddy");
  });
});
