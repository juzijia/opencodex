import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { buildConversationInput } from "../../src/adapters/coding-agent/protocol";
import { buildResponseJSON } from "../../src/bridge";
import { parseRequest } from "../../src/responses/parser";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { adapterNeedsForcedContinuation, adapterNeedsToolCallContinuation } from "../../src/server/responses/core-replay";

import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  evictOldestResponseContinuationForBudget,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";

const qoderStateOptions = {
  clientThreadId: "qoder-task",
  retainForToolContinuation: adapterNeedsToolCallContinuation("qoder"),
};

describe("Responses unforced store:false ephemeral function call state", () => {
  const priorHome = process.env["OPENCODEX_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-store-false-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  for (const stream of [false, true]) {
    for (const [name, toolTurn] of [["qoder", true], ["qoder", false], ["codebuddy", true]] as const) {
      test(`execution records only opted-in tool turns (${name}, tools=${toolTurn}, stream=${stream})`, async () => {
        const resolver = { ...await import("../../src/server/adapter-resolve") };
        const release = acquireOwnedSpendHome();
        const events: AdapterEvent[] = toolTurn ? [
          { type: "tool_call_start", id: "qoder_native_execution", name: "probe_echo" },
          { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" },
          { type: "done", stopReason: "tool_use", endTurn: false },
        ] : [{ type: "text_delta", text: "text-only answer" }, { type: "done" }];
        mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
          resolveAdapter(provider: OcxProviderConfig): ProviderAdapter {
            if (provider.adapter !== name) throw new Error("unexpected fixture adapter");
            return {
              name,
              buildRequest() { throw new Error("fixture must use runTurn"); },
              async *parseStream() { throw new Error("fixture must use runTurn"); },
              async runTurn(_parsed, _incoming, emit) { for (const event of events) emit(event); },
            };
          },
        }));
        try {
          const { handleResponses } = await import("../../src/server/responses");
          // The configured provider id is NOT the adapter name: policy uses the serving adapter.
          const config = { port: 0, defaultProvider: "fixture", providers: {
            fixture: { adapter: name, baseUrl: "https://fixture.invalid", authMode: "key", apiKey: "fixture-key",
              models: ["fixture-model"], fetch: async () => { throw new Error("no provider I/O allowed"); } },
          } } as OcxConfig;
          const response = await handleResponses(new Request("http://localhost/v1/responses", {
            method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": "qoder-task" },
            body: JSON.stringify({ model: "fixture/fixture-model", input: "use probe_echo", store: false, stream,
              tools: [{ type: "function", name: "probe_echo", parameters: { type: "object", properties: {} } }] }),
          }), config, { provider: "", model: "" });
          expect(response.status).toBe(200);
          const text = await response.text();
          const result = stream
            ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
              .find(event => event.type === "response.completed")?.response
            : JSON.parse(text);
          expect(result?.status).toBe("completed");
          expect(responseStateMetrics().count).toBe(name === "qoder" && toolTurn ? 1 : 0);
          const next = { model: "fixture-model", previous_response_id: result.id, input: [
            { type: "function_call_output", call_id: "qoder_native_execution", output: "OK" },
          ], store: false };
          const expanded = expandPreviousResponseInput(next, "qoder-task");
          if (name === "qoder" && toolTurn) {
            expect(parseRequest(expanded).context.messages.at(-1)).toMatchObject({
              role: "toolResult", toolCallId: "qoder_native_execution", toolName: "probe_echo", content: "OK",
            });
          } else expect(expanded).toEqual(next);
        } finally {
          mock.module("../../src/server/adapter-resolve", () => resolver);
          release();
        }
      });
    }
  }

  test("only Qoder opts into tool-call retention; forced eligibility is unchanged", () => {
    expect(adapterNeedsToolCallContinuation("qoder")).toBe(true);
    expect(adapterNeedsForcedContinuation("qoder")).toBe(false);
    for (const name of ["codebuddy", "coding-agent", "gemini", "volcengine", "openai", ""]) {
      expect(adapterNeedsToolCallContinuation(name)).toBe(false);
      expect(adapterNeedsForcedContinuation(name)).toBe(false);
    }
    for (const name of ["kiro", "cursor"]) {
      expect(adapterNeedsForcedContinuation(name)).toBe(true);
      expect(adapterNeedsToolCallContinuation(name)).toBe(false);
    }
  });

  for (const retainForToolContinuation of [undefined, false]) {
    test(`unforced function calls without opt-in are not retained (${retainForToolContinuation})`, () => {
      const response = { id: "resp_no_opt_in", status: "completed", output: [
        { type: "function_call", call_id: "call_native", name: "probe_echo", arguments: "{}" },
      ] };
      rememberResponseState({ input: "call probe_echo", store: false }, response, undefined, {
        clientThreadId: "codebuddy-task", retainForToolContinuation,
      });
      expect(responseStateMetrics().count).toBe(0);
      const next = { previous_response_id: response.id, input: [
        { type: "function_call_output", call_id: "call_native", output: "OK" },
      ], store: false };
      expect(expandPreviousResponseInput(next, "codebuddy-task")).toEqual(next);
    });
  }

  for (const name of ["kiro", "cursor", "passthrough"]) {
    test(`${name} force still retains store:false text and allows text continuation`, () => {
      const response = buildResponseJSON([
        { type: "text_delta", text: "forced answer" }, { type: "done" },
      ], "fixture-model");
      rememberResponseState({ input: "question", store: false }, response, undefined, {
        force: name === "passthrough" || adapterNeedsForcedContinuation(name),
        retainForToolContinuation: adapterNeedsToolCallContinuation(name),
      });
      expect(responseStateMetrics().count).toBe(1);
      expect(expandPreviousResponseInput({ previous_response_id: response.id, input: "continue" }))
        .toMatchObject({ input: [{ role: "user", content: "question" }, ...(response.output as unknown[]), { role: "user", content: "continue" }] });
    });
  }

  test("Qoder multi-tool continuation preserves both native call IDs and results", () => {
    const calls = [
      { type: "function_call", call_id: "qoder_native_A", name: "probe_a", arguments: '{"value":"A"}' },
      { type: "function_call", call_id: "qoder_native_B", name: "probe_b", arguments: '{"value":"B"}' },
    ];
    const response = { id: "resp_multi_tool", status: "completed", output: calls };
    const results = calls.map(call => ({ type: "function_call_output", call_id: call.call_id, output: `${call.name}_OK` }));
    rememberResponseState({ input: "use both tools", store: false }, response, undefined, qoderStateOptions);
    const expanded = expandPreviousResponseInput({ model: "fixture-model", previous_response_id: response.id, input: results, store: false }, "qoder-task");
    expect(expanded).toMatchObject({ input: [{ role: "user", content: "use both tools" }, ...calls, ...results] });
    const parsed = parseRequest(expanded);
    expect(parsed.context.messages.filter(message => message.role === "toolResult")).toMatchObject([
      { toolCallId: "qoder_native_A", toolName: "probe_a", content: "probe_a_OK" },
      { toolCallId: "qoder_native_B", toolName: "probe_b", content: "probe_b_OK" },
    ]);
    const projected = JSON.parse(buildConversationInput(parsed)[0]!);
    for (const call of calls) {
      expect(projected.message.content[0].text).toContain(`call_id: ${call.call_id}`);
      expect(projected.message.content[0].text).toContain(`${call.name}_OK`);
    }
  });

  test("retains a client-owned function call for store:false tool-result continuation", () => {
    const callId = "call_42cfba72566547bda98a74bc";
    const request = { model: "Qwen3.8-Flash", input: "use probe_echo", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, qoderStateOptions);
    const expanded = expandPreviousResponseInput({
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "PROBE_OK" }],
      store: false,
    }, "qoder-task");
    const parsed = parseRequest(expanded);
    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "probe_echo",
      content: "PROBE_OK",
    });
    const projected = JSON.parse(buildConversationInput(parsed)[0]!);
    expect(projected.message.content[0].text).toContain(`TOOL RESULT (call_id: ${callId}):\nPROBE_OK`);
  });

  test("refuses flagged replay when new incoming input does not match pending function call", () => {
    const callId = "call_test_pending_1";
    const request = { model: "Qwen3.8-Flash", input: "run task", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, qoderStateOptions);

    // Client sends plain text instead of function_call_output
    const textRequest = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "continue without output",
      store: false,
    };
    expect(expandPreviousResponseInput(textRequest, "qoder-task")).toEqual(textRequest);

    // Client sends output for an unrelated/mismatched call_id
    const mismatchedRequest = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: "call_different_999", output: "OTHER" }],
      store: false,
    };
    expect(expandPreviousResponseInput(mismatchedRequest, "qoder-task")).toEqual(mismatchedRequest);
  });

  test("unforced store:false without function_call is never stored", () => {
    const request = { model: "Qwen3.8-Flash", input: "hello world", store: false };
    const response = buildResponseJSON([
      { type: "text_delta", text: "hi there" },
      { type: "done" },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, qoderStateOptions);
    expect(responseStateMetrics().count).toBe(0);

    const followUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "next turn",
      store: false,
    };
    expect(expandPreviousResponseInput(followUp, "qoder-task")).toEqual(followUp);
  });

  test("unflagged store:true and forced replay remain unchanged", () => {
    const request = { model: "gpt-5.5", input: "initial query", store: true };
    const response = buildResponseJSON([
      { type: "text_delta", text: "response text" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(request, response, undefined, { clientThreadId: "task-normal" });

    const followUp = {
      model: "gpt-5.5",
      previous_response_id: response.id,
      input: "follow-up text",
      store: true,
    };
    const expanded = expandPreviousResponseInput(followUp, "task-normal") as { input: unknown[] };
    expect(Array.isArray(expanded.input)).toBe(true);
    expect(expanded.input.length).toBeGreaterThan(1);
  });

  test("preserves flagged unforcedStoreFalse provenance through snapshot flush and reload", async () => {
    const callId = "call_persisted_tool_1";
    const request = { model: "Qwen3.8-Flash", input: "use probe_echo", store: false };
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState(request, response, undefined, qoderStateOptions);
    await flushResponseState();

    // Simulate process restart
    clearResponseStateMemoryForTests();

    // Replay with matching output succeeds after reload
    const validFollowUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "RELOADED_OK" }],
      store: false,
    };
    const expanded = expandPreviousResponseInput(validFollowUp, "qoder-task");
    const parsed = parseRequest(expanded);
    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      content: "RELOADED_OK",
    });

    // Replay with text only still refused after reload
    const invalidFollowUp = {
      model: "Qwen3.8-Flash",
      previous_response_id: response.id,
      input: "some text",
      store: false,
    };
    expect(expandPreviousResponseInput(invalidFollowUp, "qoder-task")).toEqual(invalidFollowUp);
    expect(expandPreviousResponseInput({
      ...validFollowUp, input: [{ type: "function_call_output", call_id: "wrong_call_id", output: "OTHER" }],
    }, "qoder-task")).toMatchObject({ input: [{ type: "function_call_output", call_id: "wrong_call_id", output: "OTHER" }] });
  });

  test("carries flagged provenance through resident demotion, spill stub, and snapshot reload", async () => {
    const callId = "call_spilled_pending_1";
    const response = buildResponseJSON([
      { type: "tool_call_start", id: callId, name: "probe_echo" },
      { type: "tool_call_delta", arguments: '{}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ], "Qwen3.8-Flash");
    rememberResponseState({ input: "call probe_echo", store: false }, response, undefined, qoderStateOptions);
    expect(responseStateMetrics().residentCount).toBe(1);
    evictOldestResponseContinuationForBudget();
    expect(responseStateMetrics().spillStubCount).toBe(1);
    await flushResponseState();
    const snapshot = readFileSync(join(home, "responses-state.json"), "utf8");
    expect(snapshot).toContain('"unforcedStoreFalse":true');
    expect(snapshot).not.toContain("retainForToolContinuation");
    clearResponseStateMemoryForTests();

    const invalid = { previous_response_id: response.id, input: "plain text", store: false };
    expect(expandPreviousResponseInput(invalid, "qoder-task")).toEqual(invalid);
    const wrong = { previous_response_id: response.id, input: [
      { type: "function_call_output", call_id: "wrong_call_id", output: "OTHER" },
    ], store: false };
    expect(expandPreviousResponseInput(wrong, "qoder-task")).toEqual(wrong);
    const valid = { previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: callId, output: "OK" }], store: false };
    expect(expandPreviousResponseInput(valid, "qoder-task")).not.toEqual(valid);
  });
});
