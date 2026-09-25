import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { namespacedToolName, toolChoiceToolPredicate, type AdapterEvent } from "../../types";
import { isStandaloneBinary } from "../../lib/standalone";
import { CodingAgentProtocolError, mapStreamMessageToEvents, toolBridgeInitError, type StreamParseState } from "../coding-agent/protocol";
import { redactSecrets, runCodingAgentRawTurn, type CodingAgentRawTurnContext, type CodingAgentRawTurnResult, type CodingAgentToolBridgeInput, type CodingAgentTurnInput } from "../coding-agent/turn";
import { MAX_CAPTURE_BYTES, type ToolBridgeCapturePayload } from "./tool-bridge";

const CAPTURE_MATCH_WAIT_MS = 1_000;
const MAX_SIDE_CHANNEL_CALLS = 16;

type NativeInput =
  | { kind: "absent" }
  | { kind: "valid"; value: Record<string, unknown> }
  | { kind: "invalid" };

function nativeInput(block: Record<string, unknown>): NativeInput {
  if (!Object.hasOwn(block, "input")) return { kind: "absent" };
  const value = block.input;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { kind: "valid", value: value as Record<string, unknown> }
    : { kind: "invalid" };
}

export type QoderBridgeTurnInput = CodingAgentToolBridgeInput;

export interface QoderTurnInput extends CodingAgentTurnInput {
  toolBridge?: QoderBridgeTurnInput;
  appendSystemPrompt?: string;
}

/** Qoder owns its prompt transport and capture state; the shared turn owns the child process. */
export async function runQoderTurn(input: QoderTurnInput): Promise<void> {
  if (input.incoming.abortSignal?.aborted) {
    input.emit({ type: "error", message: "Coding-agent turn was aborted before start." });
    return;
  }
  let promptDir: string | undefined;
  let promptPath: string | undefined;
  try {
    if (input.appendSystemPrompt) {
      promptDir = await mkdtemp(join(tmpdir(), "ocx-system-prompt-"));
      promptPath = join(promptDir, "system-prompt.txt");
      await writeFile(promptPath, input.appendSystemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  } catch (err) {
    input.emit({ type: "error", message: `Failed to prepare the system prompt file: ${err instanceof Error ? err.message : String(err)}`, status: 500, errorType: "server_error", code: "system_prompt_setup_failed", retryable: false });
    if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  if (input.incoming.abortSignal?.aborted) {
    if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    input.emit({ type: "error", message: "Qoder turn was aborted.", retryable: false });
    return;
  }
  const bridge = input.toolBridge;
  const nonce = bridge ? randomUUID() : "";
  try {
    await runCodingAgentRawTurn({
      ...input,
      buildArgs: (profile, parsed, provider) => {
        const args = input.buildArgs(profile, parsed, provider);
        if (promptPath) args.push("--append-system-prompt-file", promptPath);
        return args;
      },
      ...(bridge ? { toolBridge: {
        ...bridge,
        serverArgs: (catalogPath: string) => isStandaloneBinary()
          ? ["__qoder-mcp", catalogPath]
          : [bridge.serverModulePath, catalogPath],
        serverEnv: (bridgeDir: string) => ({ OCX_MCP_CAPTURE_DIR: bridgeDir, OCX_MCP_CAPTURE_NONCE: nonce }),
      } } : {}),
    }, context => consumeQoderFrames(input, nonce, context));
  } finally {
    if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function consumeQoderFrames(
  input: QoderTurnInput,
  captureNonce: string,
  context: CodingAgentRawTurnContext,
): Promise<CodingAgentRawTurnResult> {
  const { parsed, incoming, toolBridge } = input;
  const { frames, bridgeDir: toolBridgeDir, emitOnce, isTerminal, kill, stopStream, profile, apiKey } = context;
  let watcher: FSWatcher | undefined;
  let sideChannelPollTimer: ReturnType<typeof setInterval> | undefined;
  let captureMatchTimer: ReturnType<typeof setTimeout> | undefined;
  const stopSideChannel = (): void => {
    if (captureMatchTimer) clearTimeout(captureMatchTimer);
    captureMatchTimer = undefined;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = undefined;
    }
    if (sideChannelPollTimer) {
      clearInterval(sideChannelPollTimer);
      sideChannelPollTimer = undefined;
    }
  };
  // One mutable capture-lifecycle flag for the whole turn: set once the side-channel capture path
  // emits its terminal (joined batch emission or a fail-closed capture error). Declared here so
  // the post-reap tail observes the same state the stream loop wrote; the previous outer const /
  // inner let shadowing is gone.
  let captureCommitted = false;
  // Collect the whole native invocation and its MCP captures before publishing any tool call.
  const nativeToolCalls: Array<{ id: string; wireName: string; json: string; input: NativeInput; rawPlaceholder: boolean; complete: boolean; malformed: boolean }> = [];
  const capturedToolCalls: Array<{ sequence: number; wireName: string; arguments: Record<string, unknown> }> = [];
  let toolCallStarts = 0;
  let initValidated = false;
  let captureMatchExpired = false;
  let streamEnded = false;
  let completeAssistantSeen = false;
  let assistantToolIds: Set<string> | undefined;
  let sideChannelCheck: Promise<void> | undefined;
  const seenToolCallIds = new Set<string>();
  let assistantMessageEnded = false;
  let pendingResultDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  const state: StreamParseState = {
    sawPartialText: false,
    sawPartialThinking: false,
    sawTerminalResult: false,
    openToolCallId: undefined,
  };

  const acceptedCaptureFiles = new Set<string>();
  // Join by native name and arguments, consuming each capture once. Native order controls publish.
  const commitSideChannelCapture = (): void => {
    if (captureCommitted || isTerminal() || incoming.abortSignal?.aborted || !toolBridge) return;
    if (nativeToolCalls.length === 0 || capturedToolCalls.length === 0 ||
        (!streamEnded && nativeToolCalls.some(call => !call.complete))) return;
    // message_stop may precede the complete assistant frame, so it cannot settle
    // a raw identity or authorize fallback from absent native input by itself.
    if (!completeAssistantSeen && !state.sawTerminalResult && !streamEnded) return;
    if (!initValidated) {
      emitOnce({ type: "error", message: "Coding-agent tool bridge init frame was not observed before completion.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
      stopSideChannel();
      kill();
      stopStream();
      return;
    }
    const consumed = new Set<number>();
    const matches = new Map<string, (typeof capturedToolCalls)[number]>();
    let invalid = assistantToolIds !== undefined &&
      (nativeToolCalls.length !== assistantToolIds.size || nativeToolCalls.some(call => !assistantToolIds!.has(call.id)));
    let missing = false;
    // Match known arguments first so a missing-input fallback cannot steal their capture.
    for (const native of nativeToolCalls) {
      if (native.malformed || native.input.kind === "invalid") { invalid = true; continue; }
      if (native.input.kind !== "valid") continue;
      const inputValue = native.input.value;
      const captured = capturedToolCalls.find(call => !consumed.has(call.sequence) &&
        call.wireName === native.wireName && isDeepStrictEqual(call.arguments, inputValue));
      if (!captured) { missing = true; continue; }
      consumed.add(captured.sequence);
      matches.set(native.id, captured);
    }
    for (const native of nativeToolCalls) {
      if (native.input.kind !== "absent") continue;
      const candidates = capturedToolCalls.filter(call => !consumed.has(call.sequence) && call.wireName === native.wireName);
      if (native.json.length !== 0 || candidates.length > 1) { invalid = true; continue; }
      // Preserve the single-call fallback; in a batch, require one remaining capture per native.
      if (!(state.sawMessageStop || streamEnded) || capturedToolCalls.length !== nativeToolCalls.length || candidates.length === 0) {
        missing = true;
        continue;
      }
      const captured = candidates[0]!;
      consumed.add(captured.sequence);
      matches.set(native.id, captured);
    }
    if (missing && !invalid && !streamEnded && !captureMatchExpired && !captureMatchTimer) {
      captureMatchTimer = setTimeout(() => {
        captureMatchExpired = true;
        commitSideChannelCapture();
      }, CAPTURE_MATCH_WAIT_MS);
    }
    if (invalid || (missing && captureMatchExpired)) {
      captureCommitted = true;
      stopSideChannel();
      emitOnce({
        type: "error",
        message: "Coding-agent CLI tool input does not match an MCP capture record.",
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
      kill();
      stopStream();
      return;
    }
    if (missing) return;
    captureCommitted = true;
    stopSideChannel();
    for (const native of nativeToolCalls) {
      const captured = matches.get(native.id)!;
      emitOnce({ type: "tool_call_start", id: native.id, name: native.wireName });
      emitOnce({ type: "tool_call_delta", arguments: JSON.stringify(captured.arguments) });
      emitOnce({ type: "tool_call_end" });
    }
    emitOnce({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      ...(state.partialUsage ? { usage: { ...state.partialUsage, ...(!state.sawMessageStop ? { estimated: true } : {}) } } : {}),
    });
    kill();
    stopStream();
  };
  const readSideChannel = async (): Promise<void> => {
    if (captureCommitted || isTerminal() || incoming.abortSignal?.aborted || !toolBridge || !toolBridgeDir) return;
    try {
      const files = await readdir(toolBridgeDir);
      if (captureCommitted || isTerminal() || incoming.abortSignal?.aborted) return;
      const captureFiles = files.filter(f => /^capture-[1-9]\d*\.json$/.test(f))
        .sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5)));
      if (captureFiles.length > MAX_SIDE_CHANNEL_CALLS) {
        emitOnce({ type: "error", message: "Too many MCP capture records.", status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
        kill();
        stopStream();
        return;
      }
      for (const file of captureFiles) {
        if (captureCommitted || isTerminal() || incoming.abortSignal?.aborted) break;
        if (acceptedCaptureFiles.has(file)) continue;
        const filePath = join(toolBridgeDir, file);
        let content: string;
        try {
          content = await readCaptureBounded(filePath);
        } catch (err) {
          if (err instanceof CodingAgentProtocolError) throw err;
          continue;
        }
        if (captureCommitted || isTerminal() || incoming.abortSignal?.aborted) return;
        if (Buffer.byteLength(content, "utf8") > MAX_CAPTURE_BYTES) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "MCP capture record exceeds byte limit.", status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
          kill();
          stopStream();
          break;
        }
        let payload: ToolBridgeCapturePayload;
        try {
          payload = JSON.parse(content);
        } catch {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "Malformed MCP capture record.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
          kill();
          stopStream();
          break;
        }
        if (!payload || typeof payload !== "object" || payload.version !== 1 || payload.nonce !== captureNonce) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "MCP capture nonce mismatch.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_mismatch", retryable: false });
          kill();
          stopStream();
          break;
        }
        if (
          typeof payload.sequence !== "number" ||
          !Number.isSafeInteger(payload.sequence) ||
          payload.sequence < 1 ||
          payload.sequence > MAX_SIDE_CHANNEL_CALLS ||
          file !== `capture-${payload.sequence}.json`
        ) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "Invalid MCP capture sequence.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
          kill();
          stopStream();
          break;
        }
        // A later record may be visible before an earlier atomic rename completes.
        if (payload.sequence > 1 && !acceptedCaptureFiles.has(`capture-${payload.sequence - 1}.json`)) continue;
        if (payload.error === undefined && (payload.arguments === null || typeof payload.arguments !== "object" || Array.isArray(payload.arguments))) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "MCP capture record has invalid arguments.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
          kill();
          stopStream();
          break;
        }
        const wireName = toolBridge.emittedNameMap.get(payload.name)
          ?? (toolBridge.serverName
            ? toolBridge.emittedNameMap.get(`mcp__${toolBridge.serverName}__${payload.name}`)
            : undefined);
        if (wireName === undefined) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "Coding-agent CLI called a tool outside the isolated catalog.", status: 502, errorType: "upstream_error", code: "undeclared_tool_call", retryable: false });
          kill();
          stopStream();
          break;
        }
        if (payload.error !== undefined) {
          stopSideChannel();
          emitOnce({ type: "error", message: "MCP capture helper rejected the tool arguments.", status: 502, errorType: "upstream_error", code: payload.error === "tool_call_limit" ? "tool_call_limit" : payload.error === "invalid_tool_arguments" ? "invalid_tool_arguments" : "protocol_error", retryable: false });
          kill();
          stopStream();
          return;
        }
        const choice = parsed.options.toolChoice;
        if (choice === "none") {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "Coding-agent CLI called a tool when tool_choice is none.", status: 502, errorType: "upstream_error", code: "undeclared_tool_call", retryable: false });
          kill();
          stopStream();
          break;
        }
        const allTools = parsed.context.tools ?? [];
        const predicate = toolChoiceToolPredicate(choice, allTools);
        const matchingTool = allTools.find(t => namespacedToolName(t.namespace, t.name) === wireName);
        if (!matchingTool || !predicate(matchingTool)) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: `Tool ${wireName} was called but tool_choice disallowed it.`, status: 502, errorType: "upstream_error", code: "tool_call_required", retryable: false });
          kill();
          stopStream();
          break;
        }
        const advertisedTool = toolBridge.tools.find(t =>
          t.name === payload.name ||
          (toolBridge.serverName && `mcp__${toolBridge.serverName}__${t.name}` === payload.name) ||
          `mcp__opencodex__${t.name}` === payload.name,
        );
        if (!advertisedTool) {
          captureCommitted = true;
          stopSideChannel();
          emitOnce({ type: "error", message: "Coding-agent CLI called a tool outside the isolated catalog.", status: 502, errorType: "upstream_error", code: "undeclared_tool_call", retryable: false });
          kill();
          stopStream();
          break;
        }
        acceptedCaptureFiles.add(file);
        capturedToolCalls.push({ sequence: payload.sequence, wireName, arguments: payload.arguments });
      }
      commitSideChannelCapture();
    } catch (err) {
      if (err instanceof CodingAgentProtocolError && !isTerminal() && !incoming.abortSignal?.aborted) {
        emitOnce({ type: "error", message: err.message, status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
        stopSideChannel();
        kill();
        stopStream();
      }
      // A directory removed during teardown needs no second terminal.
    }
  };
  // Watch, polling, and the stream can observe the same rename. One read/validation flight
  // prevents stale callbacks from publishing after cancellation or completing a record twice.
  const checkSideChannel = (): Promise<void> => {
    sideChannelCheck ??= readSideChannel().finally(() => { sideChannelCheck = undefined; });
    return sideChannelCheck;
  };
  const settleFinalCapture = async (): Promise<void> => {
    const deadline = Date.now() + CAPTURE_MATCH_WAIT_MS;
    while (!captureCommitted && !isTerminal() && !incoming.abortSignal?.aborted) {
      await checkSideChannel();
      commitSideChannelCapture();
      if (captureCommitted || isTerminal()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
    captureMatchExpired = true;
    commitSideChannelCapture();
  };
  if (toolBridge && toolBridgeDir) {
    const dir = toolBridgeDir;
    try {
      watcher = watch(dir, () => {
        void checkSideChannel();
      });
    } catch {
      /* fallback to polling if watch fails */
    }
    sideChannelPollTimer = setInterval(() => {
      void checkSideChannel();
    }, 50);
  }
  try {
    let failClosed = false;
    for await (const message of frames) {
      if (incoming.abortSignal?.aborted) break;
      if (toolBridge) {
        const initError = toolBridgeInitError(message, toolBridge.serverName);
        if (initError) {
          emitOnce({ type: "error", message: initError, status: 502, errorType: "upstream_error", code: "tool_bridge_init_mismatch", retryable: false });
          kill();
          break;
        }
        if (message.type === "system" && message.subtype === "init") initValidated = true;
      }
      if (toolBridge) {
        await checkSideChannel();
        if (captureCommitted) break;
      }
      const assistantInputs = new Map<string, { name: string; input: NativeInput }>();
      if (toolBridge && message.type === "assistant") {
        let assistantToolUseCount = 0;
        const assistant = message.message;
        const blocks = assistant && typeof assistant === "object" && !Array.isArray(assistant)
          ? (assistant as Record<string, unknown>).content
          : undefined;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block && typeof block === "object" && !Array.isArray(block)) {
              const item = block as Record<string, unknown>;
              if (item.type === "tool_use") {
                assistantToolUseCount += 1;
                if (typeof item.id === "string" && item.id) {
                  if (assistantInputs.has(item.id)) {
                    throw new CodingAgentProtocolError("Coding-agent CLI repeated a native tool ID within one assistant message.");
                  }
                  assistantInputs.set(item.id, {
                    name: typeof item.name === "string" ? item.name : "",
                    input: nativeInput(item),
                  });
                }
              }
            }
          }
        }
        if (assistantToolUseCount !== assistantInputs.size) {
          throw new CodingAgentProtocolError("Coding-agent CLI returned a native tool call without a valid ID.");
        }
        for (const native of nativeToolCalls) {
          const complete = assistantInputs.get(native.id);
          if (!complete) continue;
          if (
            toolBridge.emittedNameMap.get(complete.name) !== native.wireName ||
            complete.input.kind === "invalid" ||
            native.input.kind === "invalid" ||
            (complete.input.kind === "valid" && native.input.kind === "valid" &&
              !native.rawPlaceholder &&
              !isDeepStrictEqual(native.input.value, complete.input.value))
          ) {
            native.malformed = true;
          } else if (complete.input.kind === "valid") {
            native.input = complete.input;
            native.rawPlaceholder = false;
          }
        }
        if (assistantInputs.size > 0) {
          completeAssistantSeen = true;
          assistantToolIds = new Set(assistantInputs.keys());
        }
      }
      const rawEvent = message.type === "stream_event" && message.event &&
        typeof message.event === "object" && !Array.isArray(message.event)
        ? message.event as Record<string, unknown> : undefined;
      const rawBlock = rawEvent?.type === "content_block_start" && rawEvent.content_block &&
        typeof rawEvent.content_block === "object" && !Array.isArray(rawEvent.content_block)
        ? rawEvent.content_block as Record<string, unknown> : undefined;
      if (toolBridge && (rawEvent?.type === "message_start" || (rawBlock?.type === "tool_use" && assistantMessageEnded))) {
        seenToolCallIds.clear();
        assistantMessageEnded = false;
      }
      if (toolBridge && rawBlock?.type === "tool_use" && typeof rawBlock.id === "string" && rawBlock.id && seenToolCallIds.has(rawBlock.id)) {
        throw new CodingAgentProtocolError("Coding-agent CLI repeated a native tool ID within one assistant message.");
      }
      const mappedEvents = mapQoderStreamMessage(message, state, seenToolCallIds, Boolean(toolBridge));
      for (const event of mappedEvents) {
        if (captureCommitted) break;
        // Streamed tool_use frames supply native identities; captures supply validated arguments.
        // Neither half reaches the client until the complete batch has matched.
        if (toolBridge && event.type === "tool_call_start") {
          if (!initValidated) {
            emitOnce({ type: "error", message: "Coding-agent CLI called a tool before the tool bridge init handshake completed.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          if (nativeToolCalls.some(call => call.id === event.id)) {
            throw new CodingAgentProtocolError("Coding-agent CLI repeated a native tool ID within one invocation.");
          }
          toolCallStarts += 1;
          if (toolCallStarts > MAX_SIDE_CHANNEL_CALLS) {
            emitOnce({ type: "error", message: "Too many native tool calls in one invocation.", status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          const wireName = toolBridge.emittedNameMap.get(event.name);
          if (wireName === undefined) {
            emitOnce({ type: "error", message: "Coding-agent CLI called a tool outside the isolated catalog.", status: 502, errorType: "upstream_error", code: "undeclared_tool_call", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          const inputState = assistantInputs.get(event.id)?.input ??
            (rawBlock?.type === "tool_use" ? nativeInput(rawBlock) : { kind: "absent" } as NativeInput);
          nativeToolCalls.push({
            id: event.id, wireName, json: "", input: inputState,
            rawPlaceholder: Boolean(rawBlock && inputState.kind === "valid" && Object.keys(inputState.value).length === 0),
            complete: false, malformed: inputState.kind === "invalid",
          });
          continue;
        }
        if (toolBridge && event.type === "tool_call_delta") {
          const native = nativeToolCalls.at(-1);
          if (native && !native.complete) {
            native.json += event.arguments;
            if (Buffer.byteLength(native.json, "utf8") > MAX_CAPTURE_BYTES) {
              native.malformed = true;
              native.json = "";
            }
          }
          continue;
        }
        if (toolBridge && event.type === "tool_call_end") {
          const native = nativeToolCalls.at(-1);
          if (native) {
            native.complete = true;
            if (native.json && !native.malformed) {
              try {
                const input = JSON.parse(native.json);
                if (!input || typeof input !== "object" || Array.isArray(input) ||
                  native.input.kind === "invalid" ||
                  (native.input.kind === "valid" && !native.rawPlaceholder &&
                    !isDeepStrictEqual(native.input.value, input))) {
                  native.malformed = true;
                } else {
                  native.input = { kind: "valid", value: input };
                  native.rawPlaceholder = false;
                }
              } catch {
                native.malformed = true;
              }
            }
          }
          continue;
        }
        if (toolBridge && event.type === "done" && !initValidated) {
          emitOnce({ type: "error", message: "Coding-agent tool bridge init frame was not observed before completion.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
          failClosed = true;
          kill();
          break;
        }
        if (toolBridge && event.type === "done") {
          pendingResultDone = event;
          continue;
        }
        emitOnce(event.type === "error"
          ? { ...event, message: redactSecrets(event.message, profile.tokenEnv, apiKey) }
          : event);
      }
      if (toolBridge) {
        if (rawEvent?.type === "message_stop") assistantMessageEnded = true;
        if (message.type === "assistant") {
          seenToolCallIds.clear();
          assistantMessageEnded = false;
        }
        if (state.sawMessageStop) await checkSideChannel();
        commitSideChannelCapture();
        if (captureCommitted) break;
      }
      if (failClosed) break;
      if (
        toolBridge &&
        !isTerminal() &&
        state.sawMessageStop &&
        toolCallStarts > 0 &&
        (state.completedToolCalls ?? 0) !== toolCallStarts
      ) {
        if (!captureCommitted) {
          emitOnce({ type: "error", message: "Coding-agent CLI ended with an incomplete tool call.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
          kill();
          break;
        }
      }
      if (isTerminal()) break;
    }
    // A short-lived fake or vendor process can close stdout before the watcher/poll callback
    // runs. Read the capture directory once more while it still exists, then join or fail closed.
    streamEnded = true;
    if (!captureCommitted && toolBridge) {
      if (nativeToolCalls.length > 0 || capturedToolCalls.length > 0) await settleFinalCapture();
      else await checkSideChannel();
    }
    if (!captureCommitted && !isTerminal() && pendingResultDone && nativeToolCalls.length === 0 && capturedToolCalls.length === 0) {
      if (toolBridge?.requireToolCall && pendingResultDone.stopReason !== "tool_use" && (state.completedToolCalls ?? 0) === 0) {
        emitOnce({ type: "error", message: `${profile.label} finished without calling the required tool.`, status: 502, errorType: "upstream_error", code: "tool_call_required", retryable: false });
      } else {
        emitOnce(pendingResultDone);
      }
    }
  } catch (err) {
    kill();
    throw err;
  } finally {
    stopSideChannel();
    if (sideChannelCheck) await sideChannelCheck;
  }
  const missing = nativeToolCalls.length === 0
    ? "the native tool-use identity was never streamed"
    : "a matching MCP capture record never arrived";
  const endError: CodingAgentRawTurnResult["endError"] =
    nativeToolCalls.length > 0 || capturedToolCalls.length > 0
      ? { type: "error", message: `Coding-agent side-channel tool capture is incomplete: ${missing}.`, status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false }
      : undefined;
  return { sawTerminalResult: state.sawTerminalResult, ...(endError ? { endError } : {}) };
}

/** Qoder may send tool_use only in a complete assistant frame; keep its deduplication local. */
function mapQoderStreamMessage(
  frame: Record<string, unknown>,
  state: StreamParseState,
  seenToolCallIds: Set<string>,
  bridgeActive: boolean,
): AdapterEvent[] {
  const message = frame.message;
  const record = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
  const content = record?.content;
  if (!bridgeActive || frame.type !== "assistant" || !Array.isArray(content) ||
      !content.some(block => block && typeof block === "object" && !Array.isArray(block) && block.type === "tool_use")) {
    const events = mapStreamMessageToEvents(frame, state);
    for (const event of events) if (event.type === "tool_call_start") seenToolCallIds.add(event.id);
    if (frame.type !== "result") return events;
    return events.map(event => event.type === "error" &&
      (frame.error_code === 118 || /credit usage limit/i.test(event.message))
      ? { ...event, status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false }
      : event);
  }

  const events: AdapterEvent[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && !Array.isArray(block) && block.type === "tool_use") {
      const id = typeof block.id === "string" && block.id ? block.id : undefined;
      const name = typeof block.name === "string" && block.name ? block.name : undefined;
      if (!id || !name) continue;
      if (seenToolCallIds.has(id)) {
        if (state.openToolCallId === id) {
          state.openToolCallId = undefined;
          state.completedToolCalls = (state.completedToolCalls ?? 0) + 1;
          events.push({ type: "tool_call_end" });
        }
        continue;
      }
      seenToolCallIds.add(id);
      state.completedToolCalls = (state.completedToolCalls ?? 0) + 1;
      events.push({ type: "tool_call_start", id, name }, { type: "tool_call_end" });
    } else {
      events.push(...mapStreamMessageToEvents({ ...frame, message: { ...record, content: [block] } }, state));
    }
  }
  mapStreamMessageToEvents({ ...frame, message: { ...record, content: [] } }, state);
  return events;
}

async function readCaptureBounded(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
      throw new CodingAgentProtocolError("MCP capture record exceeds the bounded regular-file contract.");
    }
    const bytes = Buffer.allocUnsafe(MAX_CAPTURE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_CAPTURE_BYTES) throw new CodingAgentProtocolError("MCP capture record exceeds byte limit.");
    return bytes.toString("utf8", 0, used);
  } finally {
    await file.close();
  }
}
