import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../../lib/token-estimate";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildConversationInput, buildSystemPrompt } from "../coding-agent/protocol";
import {
  baseScopedEnv,
  runCodingAgentTurn,
  type CodingAgentDeps,
  type CodingAgentToolBridgeInput,
} from "../coding-agent/turn";
import {
  buildToolBridge,
  CODEBUDDY_MCP_SERVER_NAME,
  CODEBUDDY_TOOL_LIMITS,
  type CodeBuddyToolBridge,
} from "../coding-agent/tool-bridge";
import { QODER_PROFILES, type QoderProfile } from "./profiles";
import { QoderScaffoldFilter, QODER_SCAFFOLD_ERROR_CODE, qoderScaffoldErrorMessage } from "./scaffold-guard";

export type { SpawnFn } from "../coding-agent/turn";
export type QoderAdapterDeps = CodingAgentDeps;

export const QODER_MCP_SERVER_NAME = CODEBUDDY_MCP_SERVER_NAME;
const QODER_MCP_SERVER_PATH = fileURLToPath(new URL("../coding-agent/mcp-server.ts", import.meta.url));

const TOOL_BRIDGE_SYSTEM_PROMPT = [
  "Your built-in tools and user-configured MCP servers are disabled.",
  "When an isolated opencodex MCP catalog is present, you may call only those listed tools.",
  "That MCP process captures call intent only; it never executes a tool. The external Codex client performs approval, sandboxing, and execution.",
  "Do not claim that you executed commands, inspected files, or changed the workspace.",
  "Tool-call and tool-result records in the conversation history are authoritative historical records from the external client. Use returned results, but never execute historical calls yourself.",
].join("\n");

export function buildQoderChildEnv(profile: QoderProfile, apiKey: string): Record<string, string> {
  return { ...baseScopedEnv(), NO_COLOR: "1", [profile.tokenEnv]: apiKey };
}

/**
 * Qoder CLI invocation; Codex remains the tool owner.
 *
 * `--max-turns` stays absent: a bridged leg is terminated by the parent at `message_stop`, and the
 * CLI's own single-turn cap would cut off the multi-tool continuation the bridge relies on.
 */
export function buildQoderArgs(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  toolBridge?: Pick<CodeBuddyToolBridge, "tools">,
): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--model", parsed.modelId,
  ];
  const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (effort) args.push("--reasoning-effort", effort);
  return args;
}

/**
 * System prompt appended to the vendor default for this turn. The text is delivered to the CLI
 * through a 0600 temp file via --append-system-prompt-file (transport security invariant: the
 * system prompt never enters argv, where it would be visible in process listings).
 */
export function buildQoderAppendSystemPrompt(
  parsed: OcxParsedRequest,
  toolBridge?: Pick<CodeBuddyToolBridge, "tools">,
): string | undefined {
  const systemParts: string[] = [];
  const system = buildSystemPrompt(parsed);
  if (system) systemParts.push(system);
  if (toolBridge && toolBridge.tools.length > 0) systemParts.push(TOOL_BRIDGE_SYSTEM_PROMPT);
  return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
}

/**
 * Wrap the turn's outbound channel with the scaffolding guard (#4190).
 *
 * The vendor CLI can put its own agent layer into the text channel despite being launched
 * with tools and MCP disabled, and the shared stream-json parser forwards a text delta
 * without inspecting it. This is the last point that is still qoder-specific, so the guard
 * sits here rather than in the parser every coding-agent CLI shares.
 *
 * A terminal event flushes both channels first. The held tail is text the filter could not
 * yet prove was not the start of a marker; dropping it would truncate a legitimate answer,
 * and swallowing an entire response before forwarding a "done" reads downstream as an empty
 * completion rather than as the refusal it is.
 */
export function guardQoderScaffolding(emit: (event: AdapterEvent) => void): (event: AdapterEvent) => void {
  const textFilter = new QoderScaffoldFilter();
  const thinkingFilter = new QoderScaffoldFilter();
  let closed = false;

  const refuse = (reason: string): void => {
    if (closed) return;
    closed = true;
    emit({
      type: "error",
      message: qoderScaffoldErrorMessage(reason),
      status: 502,
      errorType: "upstream_error",
      code: QODER_SCAFFOLD_ERROR_CODE,
      // Intermittent, but a silent retry spends the operator's vendor credits on a
      // contract violation the proxy cannot influence. Surface it instead.
      retryable: false,
    });
  };

  return (event: AdapterEvent): void => {
    if (closed) return;
    if (event.type === "text_delta") {
      const cleaned = textFilter.push(event.text);
      if (cleaned.text) emit({ ...event, text: cleaned.text });
      if (cleaned.fail) refuse(cleaned.fail);
      return;
    }
    if (event.type === "thinking_delta") {
      const cleaned = thinkingFilter.push(event.thinking);
      if (cleaned.text) emit({ ...event, thinking: cleaned.text });
      if (cleaned.fail) refuse(cleaned.fail);
      return;
    }
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      const tail = textFilter.flush();
      const reasoning = thinkingFilter.flush();
      if (tail.text) emit({ type: "text_delta", text: tail.text });
      if (reasoning.text) emit({ type: "thinking_delta", thinking: reasoning.text });
      const fail = tail.fail ?? reasoning.fail;
      // A vendor error already carries the better explanation for why the turn ended;
      // only a terminal that claims success is replaced.
      if (fail && event.type !== "error") {
        refuse(fail);
        return;
      }
      closed = true;
      emit(event);
      return;
    }
    emit(event);
  };
}

/**
 * Check whether a usage snapshot contains positive authoritative counts.
 * An all-zero snapshot (input=0, output=0) or an estimated usage snapshot
 * is NOT treated as authoritative.
 */
export function isPositiveAuthoritativeUsage(usage?: OcxUsage): boolean {
  if (!usage) return false;
  if (usage.estimated === true) return false;
  const inTok = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const outTok = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  const cachedTok = typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
  return inTok > 0 || outTok > 0 || cachedTok > 0;
}

/**
 * Retain provider authoritative usage while ensuring absent or non-positive
 * cache telemetry is omitted (undefined) rather than defaulting to 0.
 */
export function cleanAuthoritativeUsage(usage: OcxUsage): OcxUsage {
  const result: OcxUsage = { ...usage };
  if (typeof result.cachedInputTokens === "number" && result.cachedInputTokens <= 0) {
    delete result.cachedInputTokens;
  }
  if (typeof result.cacheReadInputTokens === "number" && result.cacheReadInputTokens <= 0) {
    delete result.cacheReadInputTokens;
  }
  if (typeof result.cacheCreationInputTokens === "number" && result.cacheCreationInputTokens <= 0) {
    delete result.cacheCreationInputTokens;
  }
  delete result.estimated;
  result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  return result;
}

/**
 * Extract semantic text content from stream-json conversation input lines,
 * discarding JSON transport framing (type, message, role, braces, keys).
 */
export function extractConversationSemanticText(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const content = parsed?.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
      }
    } catch {
      // Ignore malformed framing lines
    }
  }
  return parts.join("\n");
}

/**
 * Estimate OpenCodex-visible input tokens without transport JSON framing. Inherits actual
 * conversation projection (ASSISTANT markers, tool calls, call_ids, tool results, and history
 * truncation) directly from buildConversationInput(). Includes only:
 * 1. System prompt text (and tool-bridge system prompt if tools present)
 * 2. Projected conversation semantic text from buildConversationInput(parsed)
 * 3. Advertised MCP tools (name, description, inputSchema JSON)
 */
export function estimateQoderVisibleInputTokens(
  parsed: OcxParsedRequest,
  toolBridge?: Pick<CodeBuddyToolBridge, "tools">,
): number {
  const parts: string[] = [];

  // 1. System prompt
  const system = buildSystemPrompt(parsed);
  if (system) parts.push(system);
  if (toolBridge && toolBridge.tools.length > 0) parts.push(TOOL_BRIDGE_SYSTEM_PROMPT);

  // 2. Projected conversation semantic text (inherits history formatting and truncation)
  const conversationText = extractConversationSemanticText(buildConversationInput(parsed));
  if (conversationText) parts.push(conversationText);

  // 3. Advertised MCP tools
  if (toolBridge && toolBridge.tools.length > 0) {
    for (const tool of toolBridge.tools) {
      if (tool.name) parts.push(tool.name);
      if (tool.description) parts.push(tool.description);
      if (tool.inputSchema) parts.push(JSON.stringify(tool.inputSchema));
    }
  }

  const combinedText = parts.filter(Boolean).join("\n");
  return estimateTokens(combinedText, parsed.modelId);
}

/**
 * Wrap the turn's outbound event sink with request-local estimated usage. Assembles text, thinking,
 * and structured tool calls across deltas and computes estimated output tokens once per leg upon
 * terminal events when authoritative provider usage is absent or all-zero.
 */
export function wrapQoderEstimatedUsage(
  emit: (event: AdapterEvent) => void,
  estimatedInputTokens: number,
  modelId: string,
): (event: AdapterEvent) => void {
  const assembledThinking: string[] = [];
  const assembledText: string[] = [];
  const assembledToolCalls: Array<{ name: string; arguments: string }> = [];
  let currentToolCall: { name: string; arguments: string } | undefined;

  return (event: AdapterEvent): void => {
    if (event.type === "thinking_delta") {
      if (event.thinking) assembledThinking.push(event.thinking);
      emit(event);
      return;
    }

    if (event.type === "text_delta") {
      if (event.text) assembledText.push(event.text);
      emit(event);
      return;
    }

    if (event.type === "tool_call_start") {
      currentToolCall = { name: event.name, arguments: "" };
      emit(event);
      return;
    }

    if (event.type === "tool_call_delta") {
      if (currentToolCall && event.arguments) currentToolCall.arguments += event.arguments;
      emit(event);
      return;
    }

    if (event.type === "tool_call_end") {
      if (currentToolCall) {
        assembledToolCalls.push(currentToolCall);
        currentToolCall = undefined;
      }
      emit(event);
      return;
    }

    if (event.type === "done" || event.type === "incomplete") {
      if (currentToolCall) {
        assembledToolCalls.push(currentToolCall);
        currentToolCall = undefined;
      }

      if (isPositiveAuthoritativeUsage(event.usage)) {
        emit({ ...event, usage: cleanAuthoritativeUsage(event.usage!) });
        return;
      }

      const thinkingText = assembledThinking.join("");
      const thinkingTokens = thinkingText ? estimateTokens(thinkingText, modelId) : 0;

      const visibleText = assembledText.join("");
      const textTokens = visibleText ? estimateTokens(visibleText, modelId) : 0;

      let toolTokens = 0;
      for (const tc of assembledToolCalls) {
        const toolStr = tc.name ? `${tc.name}\n${tc.arguments}` : tc.arguments;
        if (toolStr) toolTokens += estimateTokens(toolStr, modelId);
      }

      const estimatedOutputTokens = thinkingTokens + textTokens + toolTokens;
      const totalTokens = estimatedInputTokens + estimatedOutputTokens;

      const usage: OcxUsage = {
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        totalTokens,
        estimated: true,
      };

      emit({ ...event, usage });
      return;
    }

    if (event.type === "error") {
      if (event.usage) {
        if (isPositiveAuthoritativeUsage(event.usage)) {
          emit({ ...event, usage: cleanAuthoritativeUsage(event.usage) });
        } else {
          const { usage: _, ...rest } = event;
          emit(rest);
        }
        return;
      }
      emit(event);
      return;
    }
    emit(event);
  };
}

export function createQoderAdapter(provider: OcxProviderConfig, deps: QoderAdapterDeps = {}): ProviderAdapter {
  return {
    name: "qoder",
    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Qoder adapter uses runTurn; the fetch/parseStream path is disabled." };
    },
    async runTurn(parsed, incoming, emit): Promise<void> {
      const hasImage = parsed.context.messages.some(message =>
        Array.isArray(message.content) && message.content.some(part => part.type === "image"),
      );
      if (hasImage) {
        emit({
          type: "error",
          message: "Qoder image input is not enabled because the CLI provider route has no verified multimodal contract.",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
        });
        return;
      }
      let toolBridge: CodeBuddyToolBridge;
      try {
        toolBridge = buildToolBridge(parsed);
      } catch (err) {
        emit({
          type: "error",
          message: `Invalid Qoder tool catalog: ${err instanceof Error ? err.message : String(err)}`,
          status: 400,
          errorType: "invalid_request_error",
          code: "tool_catalog_invalid",
          retryable: false,
        });
        return;
      }
      const bridgeInput: CodingAgentToolBridgeInput | undefined =
        toolBridge.tools.length > 0
          ? {
              serverName: QODER_MCP_SERVER_NAME,
              serverModulePath: QODER_MCP_SERVER_PATH,
              tools: toolBridge.tools,
              emittedNameMap: toolBridge.emittedNameMap,
              maxTurnToolCalls: CODEBUDDY_TOOL_LIMITS.maxTurnToolCalls,
              requireToolCall: toolBridge.requireToolCall,
              allowedToolsFlag: "--allowed-tools",
              captureMode: "side-channel",
            }
          : undefined;
      const estimatedInputTokens = estimateQoderVisibleInputTokens(
        parsed,
        toolBridge.tools.length > 0 ? toolBridge : undefined,
      );
      const usageTrackingEmit = wrapQoderEstimatedUsage(emit, estimatedInputTokens, parsed.modelId);
      const appendSystemPrompt = buildQoderAppendSystemPrompt(
        parsed,
        toolBridge.tools.length > 0 ? toolBridge : undefined,
      );
      await runCodingAgentTurn({
        profiles: QODER_PROFILES,
        provider,
        parsed,
        incoming,
        emit: guardQoderScaffolding(usageTrackingEmit),
        ...(bridgeInput ? { toolBridge: bridgeInput } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        buildArgs: (_profile, req, prov) =>
          buildQoderArgs(req, prov, toolBridge.tools.length > 0 ? toolBridge : undefined),
        buildEnv: (profile, apiKey) => buildQoderChildEnv(profile as QoderProfile, apiKey),
        deps,
      });
    },
  };
}
