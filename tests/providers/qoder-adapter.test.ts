import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { buildQoderArgs, buildQoderChildEnv, createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { clearQoderBinaryCache, QODER_CN_PROFILE, QODER_GLOBAL_PROFILE, resolveQoderProfile } from "../../src/adapters/qoder/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();
beforeEach(() => clearQoderBinaryCache());

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "qoder-pat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], ...overrides } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return { modelId: "Qwen3.8-Max", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, ...overrides } as OcxParsedRequest;
}

function fakeChild(frames: string[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  child.stdout = Readable.from(frames.map(frame => enc.encode(frame)));
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 2);
  return child;
}

describe("qoder adapter", () => {
  test("uses only the Global PAT and disables tools, MCP, settings hooks, and persistence", () => {
    const env = buildQoderChildEnv(QODER_GLOBAL_PROFILE, "qoder-pat");
    expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBe("qoder-pat");
    expect(Object.keys(env).filter(key => key.startsWith("QODER"))).toEqual(["QODER_PERSONAL_ACCESS_TOKEN"]);
    const args = buildQoderArgs(parsed({ options: { reasoning: "high" } }), provider());
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("system prompt content never enters argv; only the private file path is passed", () => {
    const secretPrompt = "This is a private developer instruction that must not leak.";
    const p = parsed({
      context: {
        systemPrompt: ["Be terse.", "Never mention internal details."],
        messages: [
          { role: "developer", content: secretPrompt, timestamp: 0 },
          { role: "user", content: "hello", timestamp: 1 },
        ],
      },
    });

    // With a private file path, argv carries ONLY the path — never the text.
    const args = buildQoderArgs(p, provider(), undefined, "/tmp/ocx-qoder-system-prompt-xxx/system-prompt.txt");
    const idx = args.indexOf("--append-system-prompt-file");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/ocx-qoder-system-prompt-xxx/system-prompt.txt");
    expect(args).not.toContain("--append-system-prompt");
    for (const token of args) {
      expect(token).not.toContain("Be terse.");
      expect(token).not.toContain("Never mention internal details.");
      expect(token).not.toContain(secretPrompt);
    }

    // Without a path, no system prompt arg is emitted at all (no inline fallback).
    const noPath = buildQoderArgs(p, provider());
    expect(noPath).not.toContain("--append-system-prompt");
    expect(noPath).not.toContain("--append-system-prompt-file");
    for (const token of noPath) {
      expect(token).not.toContain("Be terse.");
      expect(token).not.toContain(secretPrompt);
    }
  });

  test("runTurn writes the system prompt to a private temp file, passes only its path, and cleans it up", async () => {
    const secretPrompt = "PRIVATE developer instruction content";
    const p = parsed({
      context: {
        systemPrompt: ["System line one.", "System line two."],
        messages: [
          { role: "developer", content: secretPrompt, timestamp: 0 },
          { role: "user", content: "hello", timestamp: 1 },
        ],
      },
    });
    let seenArgs: readonly string[] | undefined;
    let fileContentDuringTurn: string | undefined;
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: (_cmd, args) => {
        seenArgs = args;
        const idx = args.indexOf("--append-system-prompt-file");
        if (idx >= 0) {
          fileContentDuringTurn = readFileSync(args[idx + 1]!, "utf8");
        }
        return fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
      },
      killGraceMs: 10,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(p, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    const idx = seenArgs!.indexOf("--append-system-prompt-file");
    expect(idx).toBeGreaterThanOrEqual(0);
    const filePath = seenArgs![idx + 1]!;
    expect(filePath).toContain("ocx-qoder-system-prompt-");
    expect(filePath.endsWith("system-prompt.txt")).toBe(true);
    // argv never carries the text
    for (const token of seenArgs!) {
      expect(token).not.toContain("PRIVATE developer instruction content");
      expect(token).not.toContain("System line one.");
    }
    // While the turn is live the file exists and holds system + developer folded text
    expect(fileContentDuringTurn).toBe(`System line one.\n\nSystem line two.\n\n${secretPrompt}`);
    // Private temp dir is removed after the turn settles
    expect(existsSync(dirname(filePath))).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  test("keeps Global and CN profiles, executables, destinations, and PAT variables isolated", async () => {
    expect(resolveQoderProfile("https://qoder.com/")).toBe(QODER_GLOBAL_PROFILE);
    expect(resolveQoderProfile("https://qoder.cn/")).toBe(QODER_CN_PROFILE);
    expect(QODER_CN_PROFILE.binaryCandidates).toEqual(["qodercn", "qoderclicn"]);

    const globalEnv = buildQoderChildEnv(QODER_GLOBAL_PROFILE, "global-pat");
    const cnEnv = buildQoderChildEnv(QODER_CN_PROFILE, "cn-pat");
    expect(globalEnv.QODER_PERSONAL_ACCESS_TOKEN).toBe("global-pat");
    expect(globalEnv.QODERCN_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(cnEnv.QODERCN_PERSONAL_ACCESS_TOKEN).toBe("cn-pat");
    expect(cnEnv.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();

    const spawned: Array<{ executable: string; env: NodeJS.ProcessEnv }> = [];
    const runRegion = async (configured: OcxProviderConfig, executable: string) => {
      const adapter = createQoderAdapter(configured, {
        which: candidate => candidate === executable ? `/bin/${candidate}` : undefined,
        spawn: (command, _args, options) => {
          spawned.push({ executable: command, env: options.env ?? {} });
          return fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
        },
      });
      await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, () => {});
    };
    await Promise.all([
      runRegion(provider({ baseUrl: "https://qoder.com", apiKey: "global-pat" }), "qoder"),
      runRegion(provider({ baseUrl: "https://qoder.cn", apiKey: "cn-pat" }), "qodercn"),
    ]);
    expect(spawned).toHaveLength(2);
    const global = spawned.find(item => item.executable.endsWith("/qoder"))!;
    const cn = spawned.find(item => item.executable.endsWith("/qodercn"))!;
    expect(global.env.QODER_PERSONAL_ACCESS_TOKEN).toBe("global-pat");
    expect(global.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(cn.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBe("cn-pat");
    expect(cn.env.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });

  test("fails closed before spawn for a non-canonical destination", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider({ baseUrl: "https://evil.example.test" }), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination" });
  });

  test("rejects unverified image input instead of silently dropping or forwarding it", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const request = parsed({ context: { messages: [{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }], timestamp: 0 }] } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "unsupported_input_modality" });
  });

  test("maps Qoder credit exhaustion to a non-retryable 429", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => fakeChild([
        '{"type":"assistant","message":{"content":[{"type":"text","text":"limit"}]} }\n',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["You reached your credit usage limit"],"error_code":118}\n',
      ]),
      killGraceMs: 10,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false });
  });
});
