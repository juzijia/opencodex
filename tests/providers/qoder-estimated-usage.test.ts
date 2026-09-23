import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  createQoderAdapter,
  estimateQoderVisibleInputTokens,
  extractConversationSemanticText,
  isPositiveAuthoritativeUsage,
  cleanAuthoritativeUsage,
  wrapQoderEstimatedUsage,
} from "../../src/adapters/qoder/adapter";
import { buildConversationInput, projectedHistoryCharLimit } from "../../src/adapters/coding-agent/protocol";
import { estimateTokens } from "../../src/lib/token-estimate";
import {
  clearQoderBinaryCache,
  QODER_GLOBAL_PROFILE,
} from "../../src/adapters/qoder/profiles";
import type {
  AdapterEvent,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxUsage,
} from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { usageStatusForFinalLog } from "../../src/usage/log";

const enc = new TextEncoder();
beforeEach(() => clearQoderBinaryCache());

function testProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "qoder",
    baseUrl: "https://qoder.com",
    apiKey: "qoder-pat",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function testParsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "Qwen3.8-Flash",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "请帮我写一个快速排序算法\nfunction quickSort(arr) {}", timestamp: 0 }],
    },
    ...overrides,
  } as OcxParsedRequest;
}

function fakeChild(frames: string[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    killed: boolean;
    exitCode: number | null;
  };
  child.stdout = Readable.from(frames.map((frame) => enc.encode(frame)));
  child.stderr = Readable.from([]);
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  setTimeout(() => {
    child.exitCode = 0;
    child.emit("close", 0);
  }, 5);
  return child;
}

describe("Qoder estimated usage", () => {
  test("1. Qoder all-zero upstream usage triggers estimated fallback", async () => {
    const events: AdapterEvent[] = [];
    const adapter = createQoderAdapter(testProvider(), {
      which: () => "/bin/qoder",
      spawn: () =>
        fakeChild([
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Here is quicksort"}}}\n',
          '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n',
        ]),
    });

    await adapter.runTurn!(
      testParsed(),
      {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
      },
      (e) => events.push(e),
    );

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage).toBeDefined();
    expect(done!.usage!.estimated).toBe(true);
    expect(done!.usage!.inputTokens).toBeGreaterThan(0);
    expect(done!.usage!.outputTokens).toBeGreaterThan(0);
    expect(done!.usage!.totalTokens).toBe(done!.usage!.inputTokens + done!.usage!.outputTokens);
    // Cache unknown: fields must be undefined, never 0
    expect(done!.usage!.cachedInputTokens).toBeUndefined();
    expect(done!.usage!.cacheReadInputTokens).toBeUndefined();
    expect(done!.usage!.cacheCreationInputTokens).toBeUndefined();
  });

  test("2. Qoder positive authoritative usage is preserved and not overwritten by estimate", async () => {
    const events: AdapterEvent[] = [];
    const adapter = createQoderAdapter(testProvider(), {
      which: () => "/bin/qoder",
      spawn: () =>
        fakeChild([
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Real response"}}}\n',
          '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1500,"output_tokens":120}}\n',
        ]),
    });

    await adapter.runTurn!(
      testParsed(),
      {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
      },
      (e) => events.push(e),
    );

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage).toBeDefined();
    expect(done!.usage!.inputTokens).toBe(1500);
    expect(done!.usage!.outputTokens).toBe(120);
    expect(done!.usage!.totalTokens).toBe(1620);
    expect(done!.usage!.estimated).toBeUndefined();
  });

  test("3. mixed Chinese + English/code input produces estimate > 0", () => {
    const req = testParsed({
      context: {
        messages: [
          {
            role: "user",
            content: "这是一个混合测试：Please write a quicksort algorithm in TypeScript:\nconst sort = (xs: number[]) => xs.sort();",
            timestamp: 0,
          },
        ],
      },
    });
    const est = estimateQoderVisibleInputTokens(req);
    expect(est).toBeGreaterThan(15);
  });

  test("4. tool call leg produces estimated usage > 0", () => {
    const events: AdapterEvent[] = [];
    const emit = wrapQoderEstimatedUsage((e) => events.push(e), 50, "Qwen3.8-Flash");

    emit({ type: "tool_call_start", id: "call_1", name: "view_file" });
    emit({ type: "tool_call_delta", arguments: '{"path":"src/index.ts"}' });
    emit({ type: "tool_call_end" });
    emit({ type: "done", stopReason: "tool_use", endTurn: false });

    expect(events).toHaveLength(4);
    const done = events[3];
    expect(done.type).toBe("done");
    expect(done.usage).toBeDefined();
    expect(done.usage!.estimated).toBe(true);
    expect(done.usage!.inputTokens).toBe(50);
    expect(done.usage!.outputTokens).toBeGreaterThan(0);
    expect(done.usage!.totalTokens).toBe(50 + done.usage!.outputTokens);
  });

  test("5. final text leg produces estimated output > 0", () => {
    const events: AdapterEvent[] = [];
    const emit = wrapQoderEstimatedUsage((e) => events.push(e), 80, "Qwen3.8-Flash");

    emit({ type: "thinking_delta", thinking: "Let me think about how to solve this." });
    emit({ type: "text_delta", text: "Here is the completed solution." });
    emit({ type: "done", stopReason: "stop" });

    expect(events).toHaveLength(3);
    const done = events[2];
    expect(done.type).toBe("done");
    expect(done.usage).toBeDefined();
    expect(done.usage!.estimated).toBe(true);
    expect(done.usage!.inputTokens).toBe(80);
    expect(done.usage!.outputTokens).toBeGreaterThan(5);
    expect(done.usage!.totalTokens).toBe(80 + done.usage!.outputTokens);
  });

  test("6. cache unknown semantics: cache fields are absent / undefined, never 0", () => {
    const events: AdapterEvent[] = [];
    const emit = wrapQoderEstimatedUsage((e) => events.push(e), 100, "Qwen3.8-Flash");

    // All-zero upstream frame with 0 cache
    emit({
      type: "done",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });

    const done = events[0];
    expect(done.type).toBe("done");
    expect(done.usage).toBeDefined();
    expect(done.usage!.estimated).toBe(true);
    expect("cachedInputTokens" in done.usage!).toBe(false);
    expect("cacheReadInputTokens" in done.usage!).toBe(false);
    expect("cacheCreationInputTokens" in done.usage!).toBe(false);
    expect(done.usage!.cachedInputTokens).toBeUndefined();
    expect(done.usage!.cacheReadInputTokens).toBeUndefined();
    expect(done.usage!.cacheCreationInputTokens).toBeUndefined();
  });

  test("7 & 8. estimated=true maps to usageStatus=estimated", () => {
    const usage: OcxUsage = {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      estimated: true,
    };
    expect(usage.estimated).toBe(true);
    const status = usageStatusForFinalLog(usage);
    expect(status).toBe("estimated");
  });

  test("9. Scaffold guard integration and refusal preserved", async () => {
    const events: AdapterEvent[] = [];
    const adapter = createQoderAdapter(testProvider(), {
      which: () => "/bin/qoder",
      spawn: () =>
        fakeChild([
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking.<functions.exec>\\n<parameter name=\\"cmd\\">cd /srv/private</parameter>\\n</invoke>"}}}\n',
          '{"type":"result","subtype":"success","is_error":false}\n',
        ]),
    });

    await adapter.runTurn!(
      testParsed(),
      {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
      },
      (e) => events.push(e),
    );

    // Scaffold guard refuses the scaffolding attempt with 502
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err?.status).toBe(502);
  });

  test("Regression A: real conversation projection markers and semantics are measured", () => {
    const multiTurnReq: OcxParsedRequest = {
      modelId: "Qwen3.8-Flash",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: "What is the weather?", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should check the weather." },
              { type: "text", text: "Checking weather now." },
              {
                type: "toolCall",
                id: "call_abc123",
                name: "get_weather",
                arguments: { city: "Hangzhou" },
              },
            ],
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_abc123",
            toolName: "get_weather",
            content: '{"temp": 25, "condition": "sunny"}',
            isError: false,
            timestamp: 3,
          },
          { role: "user", content: "Thanks! Now plan an outdoor trip.", timestamp: 4 },
        ],
      },
    };

    const convLines = buildConversationInput(multiTurnReq);
    const projectedSemanticText = extractConversationSemanticText(convLines);

    // Verify projected representation is actually present in semantic text
    expect(projectedSemanticText).toContain("Prior conversation context:");
    expect(projectedSemanticText).toContain("ASSISTANT:");
    expect(projectedSemanticText).toContain("[Thinking: I should check the weather.]");
    expect(projectedSemanticText).toContain('[Tool call: get_weather (call_id: call_abc123) with args: {"city":"Hangzhou"}]');
    expect(projectedSemanticText).toContain("TOOL RESULT (call_id: call_abc123):");
    expect(projectedSemanticText).toContain("Current user request:");
    expect(projectedSemanticText).toContain("Thanks! Now plan an outdoor trip.");

    // Tool result continuation request framing:
    const toolContinuationReq: OcxParsedRequest = {
      modelId: "Qwen3.8-Flash",
      stream: true,
      options: {},
      context: {
        messages: multiTurnReq.context.messages.slice(0, 3),
      },
    };
    const continuationSemanticText = extractConversationSemanticText(buildConversationInput(toolContinuationReq));
    expect(continuationSemanticText).toContain("Please proceed based on the above tool result.");

    // The estimated tokens directly match the projected semantic text tokens
    const estTokens = estimateQoderVisibleInputTokens(multiTurnReq);
    expect(estTokens).toBeGreaterThan(60);
  });

  test("Regression B: estimator inherits buildConversationInput history truncation", () => {
    // Generate large historical text exceeding the 200,000 char threshold
    const largeChunk = "0123456789abcdefghij".repeat(5000); // 100,000 chars

    // Request A: 250,000 chars of history
    const reqA: OcxParsedRequest = {
      modelId: "Qwen3.8-Flash",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: `History chunk A1: ${largeChunk}`, timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: `History chunk A2: ${largeChunk}` }], timestamp: 2 },
          { role: "user", content: `History chunk A3: ${largeChunk.slice(0, 50000)}`, timestamp: 3 },
          { role: "user", content: "Current active query", timestamp: 4 },
        ],
      },
    };

    // Request B: Extra 100,000 chars prepended to the beginning (which gets truncated away)
    const reqB: OcxParsedRequest = {
      modelId: "Qwen3.8-Flash",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: `Extra old chunk that will be truncated: ${largeChunk}`, timestamp: 0 },
          { role: "user", content: `History chunk A1: ${largeChunk}`, timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: `History chunk A2: ${largeChunk}` }], timestamp: 2 },
          { role: "user", content: `History chunk A3: ${largeChunk.slice(0, 50000)}`, timestamp: 3 },
          { role: "user", content: "Current active query", timestamp: 4 },
        ],
      },
    };

    const estA = estimateQoderVisibleInputTokens(reqA);
    const estB = estimateQoderVisibleInputTokens(reqB);

    expect(estA).toBeGreaterThan(50000);
    expect(estB).toBeGreaterThan(50000);
    expect(estA).toBe(estB);

    const wideProvider = testProvider({ contextWindow: 1_000_000 });
    const sentText = extractConversationSemanticText(buildConversationInput(reqA, {
      maxHistoryChars: projectedHistoryCharLimit(wideProvider.contextWindow),
    }));
    expect(estimateQoderVisibleInputTokens(reqA, undefined, wideProvider)).toBe(estimateTokens(sentText, reqA.modelId));
    expect(estimateQoderVisibleInputTokens(reqA, undefined, wideProvider)).toBeGreaterThan(estA);
  });

});
