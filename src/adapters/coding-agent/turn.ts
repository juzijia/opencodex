import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { watch, type FSWatcher } from "node:fs";
import { namespacedToolName, toolChoiceToolPredicate } from "../../types";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { commandInvocation } from "../../lib/win-exec";
import { isStandaloneBinary } from "../../lib/standalone";
import { modelRecordValue } from "../../reasoning-effort";
import type { IncomingMeta } from "../base";
import { buildConversationInput, CodingAgentProtocolError, mapStreamMessageToEvents, MAX_CAPTURE_BYTES, projectedHistoryCharLimit, readJsonLines, toolBridgeInitError, type StreamParseState, type ToolBridgeCapturePayload } from "./protocol";
import { resolveCodingAgentBinary, resolveProfileByBaseUrl, type CodingAgentProviderProfile, type WhichFn } from "./profile";

/** Injectable spawn for tests; production uses node:child_process. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Injectable Windows process-tree terminator; production uses taskkill /T /F. */
export type KillWindowsProcessTreeFn = (pid: number) => void;

/** Per-turn injectables: spawn/which seams for tests plus wall-clock ceilings for timeout, kill grace, and bounded reap. */
export interface CodingAgentDeps {
  spawn?: SpawnFn;
  which?: WhichFn;
  /** Overall wall-clock ceiling for one turn (ms). */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (ms). */
  killGraceMs?: number;
  /** Maximum time to wait for a child that never reports close after termination (ms). */
  reapTimeoutMs?: number;
  /** Test seam for Windows command-shim invocation. */
  platform?: NodeJS.Platform;
  /** Test seam for terminating a Windows CLI and all descendants. */
  killWindowsProcessTree?: KillWindowsProcessTreeFn;
  /** Test seam for a catalog/config write failure after private bridge-directory creation. */
  writeToolBridgeFile?: typeof writeFile;
  /** Optional working directory for the spawned CLI process; defaults to process.cwd(). */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Bound captured stderr so an error message can never carry an unbounded (or secret) payload. */
const MAX_STDERR_BYTES = 8 * 1024;
// Some pinned CLIs park on MCP before emitting message_stop. Drain queued frames before that
// fallback, and label its accounting as partial instead of claiming a complete usage snapshot.
const CAPTURE_DRAIN_MS = 50;
// A second parallel capture can finish after the first; bound the wait for the matching record.
const CAPTURE_MATCH_WAIT_MS = 1_000;
const MAX_SIDE_CHANNEL_CALLS = 16;

function killWindowsProcessTree(pid: number): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

/** Env keys a CLI needs to run; everything else is dropped so the child env is scoped and deterministic. */
const INHERITED_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
  "SHELL", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "USERNAME", "TZ",
] as const;

/**
 * Base scoped child-process environment (§六/§十四).
 *
 * Never mutates `process.env` (no cross-provider pollution under concurrency) and never inherits a
 * parent vendor variable, so a stray region switch in the host shell cannot flip a provider's
 * region: the profile is the sole authority. Family builders layer the credential + region vars on
 * top of this.
 */
export function baseScopedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Redact the profile's credential and common secret shapes before surfacing diagnostics. */
export function redactSecrets(text: string, tokenEnv: string, credential?: string): string {
  const escaped = tokenEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let redacted = text;
  if (credential) redacted = redacted.split(credential).join("[redacted]");
  return redacted
    .replace(new RegExp(`(${escaped}\\s*[:=]\\s*)\\S+`, "gi"), "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[redacted]");
}

/** Inputs for one headless CLI turn: region profiles, request context, and family-specific arg/env builders. */
export interface CodingAgentTurnInput {
  /** Region profiles for this family; the turn fails closed if the base URL matches none. */
  profiles: readonly CodingAgentProviderProfile[];
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  /** Family-specific headless argument builder (tools disabled, model, reasoning, system prompt). */
  buildArgs: (profile: CodingAgentProviderProfile, parsed: OcxParsedRequest, provider: OcxProviderConfig) => string[];
  /** Family-specific scoped env builder (credential + region switch on top of baseScopedEnv). */
  buildEnv: (profile: CodingAgentProviderProfile, apiKey: string) => Record<string, string>;
  /**
   * Opt-in capture-only tool bridge. When present with a non-empty catalog, the turn writes a
   * validated catalog plus an MCP config to a private temp dir, passes `--mcp-config` (with exact
   * `--allowedTools`) alongside the family's tools-disabled args, translates captured tool_use
   * names back to request wire names, and terminates the process tree at `message_stop` because
   * the capture-only MCP handler intentionally never answers. Execution stays with the client.
   */
  toolBridge?: CodingAgentToolBridgeInput;
  /** Optional custom stream-json stdin lines generator; defaults to buildConversationInput(parsed). */
  buildInputLines?: (parsed: OcxParsedRequest) => string[];
  /**
   * System prompt text appended to the vendor default, delivered through a 0600 temp file and
   * --append-system-prompt-file so the prompt never appears in argv. Cleaned up with the turn.
   */
  appendSystemPrompt?: string;
  deps: CodingAgentDeps;
}

/** Opt-in capture-only tool bridge for one coding-agent CLI turn. */
export interface CodingAgentToolBridgeInput {
  /** MCP server name advertised to the CLI; tool_use blocks render it as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Absolute path of the capture-only MCP server module, run with the serving runtime. */
  serverModulePath: string;
  /** Validated tool catalog advertised over ListTools; the server never executes a call. */
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** CLI-emitted tool name (`mcp__<server>__<tool>`) to the request's wire tool name. */
  emittedNameMap: Map<string, string>;
  /** Request-local, precompiled validation against the exact advertised MCP alias. */
  validateArguments?: (name: string, args: Record<string, unknown>) => string | undefined;
  /**
   * Tool calls delivered to the host in one assistant message. Side-channel v1 delivers
   * only the first captured call; the CLI may emit more, but they never execute here.
   * The host can request another stateless invocation after returning the first result.
   */
  maxTurnToolCalls: number;
  /**
   * The request's `tool_choice` requires a tool call (`required`, or a named selection).
   * The nested CLI has no documented force-tool flag, so this is enforced locally: a
   * terminal text result on a required turn fails closed instead of silently succeeding.
   */
  requireToolCall?: boolean;
  /** Flag name used by vendor CLI to allow tools. Defaults to "--allowedTools". */
  allowedToolsFlag?: "--allowedTools" | "--allowed-tools";
  /** Tool bridge capture lifecycle mode. Defaults to "message_stop". Qoder uses "side-channel". */
  captureMode?: "side-channel" | "message_stop";
}

export function codeBuddyMcpInvocation(serverModulePath: string, catalogPath: string, standalone = isStandaloneBinary()): string[] {
  return standalone ? ["__codebuddy-mcp", catalogPath] : [serverModulePath, catalogPath];
}

function mcpInvocation(toolBridge: CodingAgentToolBridgeInput, catalogPath: string): string[] {
  if (toolBridge.captureMode !== "side-channel") return codeBuddyMcpInvocation(toolBridge.serverModulePath, catalogPath);
  return isStandaloneBinary() ? ["__qoder-mcp", catalogPath] : [toolBridge.serverModulePath, catalogPath];
}

/**
 * Run one headless coding-agent CLI turn as an OpenCodex `runTurn` (§七/§三十).
 *
 * Single transport for every official coding-agent CLI provider: fail closed on a non-canonical
 * destination, pre-flight the credential and binary, spawn with a scoped env and tools disabled, feed
 * the replayed conversation over stream-json, map the vendor's Anthropic-aligned frames to
 * AdapterEvents, and always reap the process. Codex retains tool ownership: the CLI runs with its own
 * tools disabled, so this turn yields text/reasoning (the control-protocol tool bridge is a
 * documented fast-follow).
 */
export async function runCodingAgentTurn(input: CodingAgentTurnInput): Promise<void> {
  const { profiles, provider, parsed, incoming, emit, buildArgs, buildEnv, deps } = input;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const reapTimeoutMs = deps.reapTimeoutMs ?? (killGraceMs * 2 + 250);
  const platform = deps.platform ?? process.platform;

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: "Coding-agent turn was aborted before start." });
    return;
  }

  // Fail closed on a non-canonical destination BEFORE any credential is placed in an env (§十六).
  const profile = resolveProfileByBaseUrl(profiles, provider.baseUrl);
  if (!profile) {
    emit({
      type: "error",
      message: "Provider base URL is not a canonical region destination; the credential was not sent.",
      status: 400,
      errorType: "invalid_request_error",
      code: "non_canonical_destination",
      retryable: false,
    });
    return;
  }
  const apiKey = provider.apiKey;
  if (!apiKey) {
    emit({
      type: "error",
      message: `${profile.label} credential missing — add an API key for this provider (${profile.tokenEnv}).`,
      status: 401,
      errorType: "authentication_error",
      code: "missing_credential",
      retryable: false,
    });
    return;
  }
  // Pre-flight binary discovery so a missing CLI is a clear error, not a mid-turn ENOENT (§二十六).
  const binary = resolveCodingAgentBinary(profile, deps.which);
  if (!binary) {
    emit({
      type: "error",
      message: `${profile.label} CLI not found on PATH. Install it with: ${profile.installHint}`,
      status: 500,
      errorType: "upstream_error",
      code: "cli_not_found",
      retryable: false,
    });
    return;
  }

  const toolBridge = input.toolBridge;
  const writeToolBridgeFile = deps.writeToolBridgeFile ?? writeFile;
  let toolBridgeDir: string | undefined;
  let toolBridgeMcpConfigPath: string | undefined;
  let appendSystemPromptPath: string | undefined;
  let captureNonce: string | undefined;
  // The append-system-prompt temp file shares the bridge dir lifecycle when a bridge exists; on the
  // no-tools fast path it gets its own dir so MCP setup stays opt-in. Both are 0600 and reaped.
  let systemPromptDir: string | undefined;
  const removeTemporaryFiles = async (): Promise<void> => {
    if (toolBridgeDir) await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
    if (systemPromptDir) await rm(systemPromptDir, { recursive: true, force: true }).catch(() => undefined);
  };
  if (toolBridge) {
    if (toolBridge.tools.length === 0 || toolBridge.emittedNameMap.size === 0) {
      emit({ type: "error", message: "Coding-agent tool bridge was supplied without any isolated tools.", status: 500, errorType: "server_error", code: "tool_bridge_empty", retryable: false });
      return;
    }
    captureNonce = randomUUID();
    try {
      toolBridgeDir = await mkdtemp(join(tmpdir(), "ocx-coding-agent-tools-"));
      const catalogPath = join(toolBridgeDir, "catalog.json");
      toolBridgeMcpConfigPath = join(toolBridgeDir, "mcp.json");
      await writeToolBridgeFile(catalogPath, JSON.stringify(toolBridge.tools), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeToolBridgeFile(
        toolBridgeMcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [toolBridge.serverName]: {
              type: "stdio",
              command: process.execPath,
              args: mcpInvocation(toolBridge, catalogPath),
              env: {
                ...(toolBridge.captureMode === "side-channel"
                  ? { OCX_MCP_CAPTURE_DIR: toolBridgeDir, OCX_MCP_CAPTURE_NONCE: captureNonce }
                  : {}),
              },
              defer_loading: false,
              alwaysLoad: true,
            },
          },
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      if (input.appendSystemPrompt) {
        appendSystemPromptPath = join(toolBridgeDir, "system-prompt.txt");
        await writeFile(appendSystemPromptPath, input.appendSystemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
    } catch {
      emit({
        type: "error",
        message: "Coding-agent tool bridge could not be staged securely.",
        status: 500,
        errorType: "server_error",
        code: "tool_bridge_setup_failed",
        retryable: false,
      });
      if (toolBridgeDir) await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
      if (systemPromptDir) await rm(systemPromptDir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  } else if (input.appendSystemPrompt) {
    try {
      systemPromptDir = await mkdtemp(join(tmpdir(), "ocx-system-prompt-"));
      appendSystemPromptPath = join(systemPromptDir, "system-prompt.txt");
      await writeFile(appendSystemPromptPath, input.appendSystemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (err) {
      emit({
        type: "error",
        message: `Failed to prepare the system prompt file: ${err instanceof Error ? err.message : String(err)}`,
        status: 500,
        errorType: "server_error",
        code: "system_prompt_setup_failed",
        retryable: false,
      });
      if (systemPromptDir) await rm(systemPromptDir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  }

  if (incoming.abortSignal?.aborted) {
    await removeTemporaryFiles();
    emit({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
    return;
  }
  const args = buildArgs(profile, parsed, provider);
  if (appendSystemPromptPath) {
    args.push("--append-system-prompt-file", appendSystemPromptPath);
  }
  if (toolBridge && toolBridgeMcpConfigPath) {
    // Exact names close the wildcard domain; --strict-mcp-config (family args) keeps user
    // servers out, so the capture server is the only capability this turn can reach.
    const flag = toolBridge.allowedToolsFlag ?? "--allowedTools";
    args.push(flag, [...toolBridge.emittedNameMap.keys()].join(","), "--mcp-config", toolBridgeMcpConfigPath);
  }
  const env = buildEnv(profile, apiKey);
  const invocation = commandInvocation(binary, args, platform, { env });

  let child: ChildProcess;
  const effectiveCwd = input.deps.cwd ?? process.cwd();
  try {
    child = spawnFn(invocation.file, invocation.args, {
      ...invocation.options,
      cwd: effectiveCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    emit({
      type: "error",
      message: redactSecrets(err instanceof Error ? err.message : String(err), profile.tokenEnv, apiKey),
      status: 500,
      errorType: "upstream_error",
      code: "cli_spawn_failed",
      retryable: false,
    });
    // A synchronous spawn() throw skips the event-loop `finally` below, so the private
    // bridge dir would leak unless it is removed here as well.
    if (toolBridgeDir) await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
    if (systemPromptDir) await rm(systemPromptDir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }

  // `spawn()` reports launch failures such as ENOENT asynchronously through `error`; they are not
  // reliably thrown by the call above. Subscribe immediately and create the lifecycle promise now,
  // before stdout can end, so neither a fast close nor a launch failure can be missed by the reap step.
  let childProcessError: Error | undefined;
  const processLifecycle = new Promise<void>(resolve => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", err => {
      childProcessError = err;
      // A launch failure has no process to reap and is not guaranteed to emit `close` on every runtime.
      if (child.pid === undefined) settle();
    });
    child.once("close", settle);
    if (child.exitCode !== null) settle();
  });

  let terminalEmitted = false;
  const emitOnce = (event: AdapterEvent): void => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      if (terminalEmitted) return;
      terminalEmitted = true;
    }
    emit(event);
  };

  const stderrChunks: string[] = [];
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => {
    if (killed || child.killed) return;
    killed = true;
    if (platform === "win32" && child.pid !== undefined) {
      try {
        (deps.killWindowsProcessTree ?? killWindowsProcessTree)(child.pid);
        return;
      } catch { /* fall back to terminating the direct child */ }
    }
    // The capture-only MCP server is the CLI's child. Its stdin closes when the CLI dies, and
    // mcp-server.ts exits on stdin EOF, so this ladder reaps the whole tree without knowing
    // the grandchild pid. On win32 the tree kill above already reaches it via /T.
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, killGraceMs);
  };

  const stopStream = (): void => {
    try { child.stdout?.destroy(); } catch { /* already closed */ }
  };
  const onAbort = (): void => {
    kill();
    stopStream();
  };
  incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (incoming.abortSignal?.aborted) onAbort();
  const timeoutTimer = setTimeout(() => {
    kill();
    stopStream();
    emitOnce({ type: "error", message: `${profile.label} turn timed out.`, status: 504, errorType: "upstream_error", code: "timeout", retryable: true });
  }, timeoutMs);

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderrChunks.join("").length < MAX_STDERR_BYTES) stderrChunks.push(chunk);
  });

  let watcher: FSWatcher | undefined;
  let sideChannelPollTimer: ReturnType<typeof setInterval> | undefined;
  let captureDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let captureMatchTimer: ReturnType<typeof setTimeout> | undefined;
  const stopSideChannel = (): void => {
    if (captureDrainTimer) clearTimeout(captureDrainTimer);
    captureDrainTimer = undefined;
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

  const cleanup = (): void => {
    clearTimeout(timeoutTimer);
    stopSideChannel();
    incoming.abortSignal?.removeEventListener("abort", onAbort);
    try { child.stdin?.destroy(); } catch { /* ignore */ }
    // Termination is owned by the reap step below, not here: killing in cleanup would set
    // `child.killed` and let the wait resolve before the process is actually reaped (§三十).
  };

  let streamProtocolError: string | undefined;
  let turnError: string | undefined;
  // One mutable capture-lifecycle flag for the whole turn: set once the side-channel capture path
  // emits its terminal (joined tool-call emission or a fail-closed capture error). Declared here so
  // the post-reap tail observes the same state the stream loop wrote; the previous outer const /
  // inner let shadowing is gone.
  let captureCommitted = false;
  // CodeBuddy can emit several native calls per assistant message. Qoder's side channel below
  // deliberately returns only the first call; both paths share the init/terminal guards.
  let deferredResultDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  // Side-channel join halves: the native streamed tool_use identity and the validated MCP capture
  // record are collected independently; the client sees exactly one emission once both halves are
  // present and agree on the wire tool identity.
  let nativeToolCall: { id: string; wireName: string; json: string; input?: Record<string, unknown>; complete: boolean; malformed: boolean } | undefined;
  const capturedToolCalls: Array<{ sequence: number; wireName: string; arguments: Record<string, unknown> }> = [];
  let toolCallStarts = 0;
  let initValidated = false;
  let captureDrainExpired = false;
  let captureMatchExpired = false;
  let streamEnded = false;
  let sideChannelCheck: Promise<void> | undefined;
  const state: StreamParseState = {
    sawPartialText: false,
    sawPartialThinking: false,
    sawTerminalResult: false,
    openToolCallId: undefined,
    allowCompleteToolCalls: toolBridge?.captureMode === "side-channel",
    partialToolCallIds: toolBridge?.captureMode !== "side-channel" && toolBridge ? new Set<string>() : undefined,
  };

  try {
    // Write the replayed conversation or incremental continuation, then close stdin so a single-shot turn can complete.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", () => { /* EPIPE if the CLI exits early; surfaced via close/stderr */ });
      // The projected history scales with the model context window on the routed provider row
      // (catalog and config metadata merged): a 1M-token model keeps 3M characters of replay
      // where the flat cap cut it near 50k-130k tokens of content. Absent metadata keeps the
      // flat cap.
      const historyCharLimit = projectedHistoryCharLimit(
        modelRecordValue(provider.modelContextWindows, parsed.modelId) ?? provider.contextWindow,
      );
      const lines = input.buildInputLines ? input.buildInputLines(parsed) : buildConversationInput(parsed, { maxHistoryChars: historyCharLimit });
      for (const line of lines) stdin.write(`${line}\n`);
      stdin.end();
    }
    const stdout = child.stdout;
    if (!stdout) throw new CodingAgentProtocolError(`${profile.label} CLI produced no stdout stream`);
    const acceptedCaptureFiles = new Set<string>();
    // Join by native name and arguments, never by independent stream/MCP arrival order.
    // A missing or ambiguous input cannot borrow another call's capture record.
    const commitSideChannelCapture = (): void => {
      if (captureCommitted || terminalEmitted || incoming.abortSignal?.aborted || !toolBridge) return;
      const native = nativeToolCall;
      if (!native || capturedToolCalls.length === 0 || (!native.complete && !streamEnded)) return;
      if (!streamEnded && !captureDrainExpired) {
        if (!captureDrainTimer) {
          captureDrainTimer = setTimeout(() => {
            captureDrainExpired = true;
            void checkSideChannel().then(checkSideChannel).then(commitSideChannelCapture);
          }, CAPTURE_DRAIN_MS);
        }
        return;
      }
      if (!initValidated) {
        emitOnce({ type: "error", message: "Coding-agent tool bridge init frame was not observed before completion.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
        stopSideChannel();
        kill();
        stopStream();
        return;
      }
      const captured = native.input
        ? capturedToolCalls.find(call => call.wireName === native.wireName && isDeepStrictEqual(call.arguments, native.input))
        : native.json.length === 0 && toolCallStarts === 1 && capturedToolCalls.length === 1 &&
            capturedToolCalls[0]?.wireName === native.wireName && (state.sawMessageStop || streamEnded)
          ? capturedToolCalls[0]
          : undefined;
      if (!captured && !native.malformed && !streamEnded && !captureMatchExpired && !captureMatchTimer) {
        captureMatchTimer = setTimeout(() => {
          captureMatchExpired = true;
          commitSideChannelCapture();
        }, CAPTURE_MATCH_WAIT_MS);
      }
      if (native.malformed || (!captured && (streamEnded || captureMatchExpired))) {
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
      if (!captured) return;
      captureCommitted = true;
      stopSideChannel();
      emitOnce({ type: "tool_call_start", id: native.id, name: native.wireName });
      emitOnce({ type: "tool_call_delta", arguments: JSON.stringify(captured.arguments) });
      emitOnce({ type: "tool_call_end" });
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
      if (captureCommitted || terminalEmitted || incoming.abortSignal?.aborted || !toolBridge || !toolBridgeDir) return;
      try {
        const files = await readdir(toolBridgeDir);
        if (captureCommitted || terminalEmitted || incoming.abortSignal?.aborted) return;
        const captureFiles = files.filter(f => /^capture-[1-9]\d*\.json$/.test(f))
          .sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5)));
        if (captureFiles.length > MAX_SIDE_CHANNEL_CALLS) {
          emitOnce({ type: "error", message: "Too many MCP capture records.", status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
          kill();
          stopStream();
          return;
        }
        for (const file of captureFiles) {
          if (captureCommitted || terminalEmitted || incoming.abortSignal?.aborted) break;
          if (acceptedCaptureFiles.has(file)) continue;
          const filePath = join(toolBridgeDir, file);
          let content: string;
          try {
            content = await readCaptureBounded(filePath);
          } catch (err) {
            if (err instanceof CodingAgentProtocolError) throw err;
            continue;
          }
          if (captureCommitted || terminalEmitted || incoming.abortSignal?.aborted) return;
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
            emitOnce({ type: "error", message: "MCP capture helper rejected the tool arguments.", status: 502, errorType: "upstream_error", code: payload.error === "tool_call_limit" ? "tool_call_limit" : "protocol_error", retryable: false });
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
          let validationError: string | undefined;
          try {
            validationError = toolBridge.validateArguments?.(advertisedTool.name, payload.arguments)
              ?? (toolBridge.validateArguments ? undefined : "tool validator unavailable");
          } catch (err) {
            validationError = err instanceof Error ? err.message : "schema compilation failed";
          }
          if (validationError) {
            captureCommitted = true;
            stopSideChannel();
            emitOnce({ type: "error", message: `MCP tool arguments failed schema validation: ${validationError}`, status: 502, errorType: "upstream_error", code: "invalid_tool_arguments", retryable: false });
            kill();
            stopStream();
            break;
          }
          acceptedCaptureFiles.add(file);
          capturedToolCalls.push({ sequence: payload.sequence, wireName, arguments: payload.arguments });
        }
        commitSideChannelCapture();
      } catch (err) {
        if (err instanceof CodingAgentProtocolError && !terminalEmitted && !incoming.abortSignal?.aborted) {
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
    if (toolBridge && toolBridge.captureMode === "side-channel" && toolBridgeDir) {
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
      for await (const message of readJsonLines(stdout)) {
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
        if (toolBridge?.captureMode === "side-channel") {
          await checkSideChannel();
          if (captureCommitted) break;
        }
        const assistantInputs = new Map<string, Record<string, unknown>>();
        if (toolBridge?.captureMode === "side-channel" && message.type === "assistant") {
          const assistant = message.message;
          const blocks = assistant && typeof assistant === "object" && !Array.isArray(assistant)
            ? (assistant as Record<string, unknown>).content
            : undefined;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block && typeof block === "object" && !Array.isArray(block)) {
                const item = block as Record<string, unknown>;
                if (item.type === "tool_use" && typeof item.id === "string" &&
                  item.input && typeof item.input === "object" && !Array.isArray(item.input)) {
                  assistantInputs.set(item.id, item.input as Record<string, unknown>);
                }
              }
            }
          }
          if (nativeToolCall && assistantInputs.has(nativeToolCall.id)) {
            const completeInput = assistantInputs.get(nativeToolCall.id)!;
            if (nativeToolCall.input && !isDeepStrictEqual(nativeToolCall.input, completeInput)) {
              nativeToolCall.malformed = true;
            } else {
              nativeToolCall.input = completeInput;
            }
          }
        }
        const mappedEvents = mapStreamMessageToEvents(message, state);
        if (toolBridge && toolBridge.captureMode !== "side-channel" && state.uncapturedToolUse) {
          emitOnce({ type: "error", message: "Coding-agent CLI returned a tool call without a partial tool capture.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
          kill();
          break;
        }
        for (const event of mappedEvents) {
          if (captureCommitted) break;
          // Side-channel v1: streamed tool_use frames never reach the client directly. They only
          // supply the native tool identity half of the join; the capture record supplies the
          // validated name+arguments half, and commitSideChannelCapture emits the single joined
          // tool_call sequence once both halves agree.
          if (toolBridge?.captureMode === "side-channel" && event.type === "tool_call_start") {
            if (!initValidated) {
              emitOnce({ type: "error", message: "Coding-agent CLI called a tool before the tool bridge init handshake completed.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
              failClosed = true;
              kill();
              break;
            }
            toolCallStarts += 1;
            if (toolCallStarts > MAX_SIDE_CHANNEL_CALLS) {
              emitOnce({ type: "error", message: "Coding-agent CLI returned too many tool calls in one invocation.", status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
              failClosed = true;
              kill();
              break;
            }
            // The host executes one call, then continues in a new invocation. Ignore
            // any extra native identities; their capture-only MCP calls never execute.
            if (toolCallStarts > 1) continue;
            const wireName = toolBridge.emittedNameMap.get(event.name);
            if (wireName === undefined) {
              emitOnce({ type: "error", message: "Coding-agent CLI called a tool outside the isolated catalog.", status: 502, errorType: "upstream_error", code: "undeclared_tool_call", retryable: false });
              failClosed = true;
              kill();
              break;
            }
            nativeToolCall = { id: event.id, wireName, json: "", input: assistantInputs.get(event.id), complete: false, malformed: false };
            commitSideChannelCapture();
            continue;
          }
          if (toolBridge?.captureMode === "side-channel" && event.type === "tool_call_delta") {
            if (toolCallStarts === 1 && nativeToolCall && !nativeToolCall.complete) {
              nativeToolCall.json += event.arguments;
              if (Buffer.byteLength(nativeToolCall.json, "utf8") > MAX_CAPTURE_BYTES) {
                nativeToolCall.malformed = true;
                nativeToolCall.json = "";
              }
            }
            continue;
          }
          if (toolBridge?.captureMode === "side-channel" && event.type === "tool_call_end") {
            if (toolCallStarts === 1 && nativeToolCall) {
              nativeToolCall.complete = true;
              if (nativeToolCall.json && !nativeToolCall.malformed) {
                try {
                  const input = JSON.parse(nativeToolCall.json);
                  if (!input || typeof input !== "object" || Array.isArray(input) ||
                    (nativeToolCall.input && !isDeepStrictEqual(nativeToolCall.input, input))) {
                    nativeToolCall.malformed = true;
                  } else {
                    nativeToolCall.input = input;
                  }
                } catch {
                  nativeToolCall.malformed = true;
                }
              }
              commitSideChannelCapture();
            }
            continue;
          }
          if (toolBridge && event.type === "done" && !initValidated) {
            emitOnce({ type: "error", message: "Coding-agent tool bridge init frame was not observed before completion.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          if (
            toolBridge?.captureMode === "side-channel" &&
            event.type === "done" &&
            (nativeToolCall !== undefined || capturedToolCalls.length > 0)
          ) {
            const missing = nativeToolCall === undefined
              ? "the native tool-use identity was never streamed"
              : "a matching MCP capture record never arrived";
            captureCommitted = true;
            stopSideChannel();
            emitOnce({
              type: "error",
              message: `Coding-agent side-channel tool capture is incomplete: ${missing}.`,
              status: 502,
              errorType: "upstream_error",
              code: "protocol_error",
              retryable: false,
            });
            failClosed = true;
            kill();
            break;
          }
          if (toolBridge && event.type === "tool_call_start") {
            if (!initValidated) {
              emitOnce({ type: "error", message: "Coding-agent CLI called a tool before the tool bridge init handshake completed.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
              failClosed = true;
              kill();
              break;
            }
            toolCallStarts += 1;
            if (toolCallStarts > toolBridge.maxTurnToolCalls) {
              emitOnce({ type: "error", message: `Coding-agent CLI returned more than the ${toolBridge.maxTurnToolCalls}-tool-call turn limit.`, status: 502, errorType: "upstream_error", code: "tool_call_limit", retryable: false });
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
            emitOnce({ ...event, name: wireName });
            continue;
          }
          if (
            toolBridge?.requireToolCall === true &&
            !terminalEmitted &&
            event.type === "done" &&
            event.stopReason !== "tool_use" &&
            (state.completedToolCalls ?? 0) === 0
          ) {
            // `tool_choice: required|named` on a bridge turn: a text-only terminal result must not
            // become a successful completion the client can accept. The capture-only bridge has no
            // way to force the nested CLI, so fail closed with the same stable error shape the
            // other bridge contract violations use.
            emitOnce({ type: "error", message: `${profile.label} finished without calling the required tool.`, status: 502, errorType: "upstream_error", code: "tool_call_required", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          if (toolBridge?.captureMode !== "side-channel" && toolBridge && event.type === "done" &&
            toolCallStarts > 0 && (state.completedToolCalls ?? 0) !== toolCallStarts) {
            emitOnce({ type: "error", message: "Coding-agent CLI ended with an incomplete tool call.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
            failClosed = true;
            kill();
            break;
          }
          if (toolBridge?.captureMode !== "side-channel" && toolBridge && event.type === "done" && toolCallStarts > 0) {
            deferredResultDone = event;
            continue;
          }
          emitOnce(event.type === "error"
            ? { ...event, message: redactSecrets(event.message, profile.tokenEnv, apiKey) }
            : event);
        }
        if (toolBridge?.captureMode === "side-channel") {
          if (state.sawMessageStop) {
            await checkSideChannel();
            await checkSideChannel();
          }
          commitSideChannelCapture();
          if (captureCommitted) break;
        }
        if (failClosed) break;
        if (
          toolBridge &&
          !terminalEmitted &&
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
        if (
          toolBridge &&
          toolBridge.captureMode !== "side-channel" &&
          !terminalEmitted &&
          state.sawMessageStop &&
          (state.completedToolCalls ?? 0) > 0
        ) {
          if (!initValidated) {
            emitOnce({ type: "error", message: "Coding-agent tool bridge init frame was not observed before the first tool call.", status: 502, errorType: "upstream_error", code: "tool_bridge_init_missing", retryable: false });
            kill();
            break;
          }
          // The capture-only MCP handler never answers, so the CLI parks after message_stop.
          // The completed tool_use blocks are this turn's structured output: end the leg here
          // and terminate the tree; the client executes, and the next request continues.
          // Pre-result usage snapshots keep this terminated leg accountable: no result frame
          // ever arrives for a turn parked on the never-answering capture server.
          emitOnce({
            type: "done",
            stopReason: "tool_use",
            endTurn: false,
            ...((deferredResultDone?.usage ?? state.partialUsage) ? { usage: deferredResultDone?.usage ?? state.partialUsage } : {}),
          });
          kill();
          break;
        }
        if (terminalEmitted) break;
      }
      // A short-lived fake or vendor process can close stdout before the watcher/poll callback
      // runs. Read the capture directory once more while it still exists, then join or fail closed.
      streamEnded = true;
      if (!captureCommitted && toolBridge?.captureMode === "side-channel") {
        await checkSideChannel();
        await checkSideChannel();
        commitSideChannelCapture();
      }
    } catch (err) {
      kill();
      streamProtocolError = err instanceof Error ? err.message : String(err);
    }
  } catch (err) {
    kill();
    turnError = err instanceof Error ? err.message : String(err);
  } finally {
    cleanup();
    if (sideChannelCheck) await sideChannelCheck;
  }

  // Reap the process so no zombie is left behind (§三十): wait for the real `close`, and
  // force-terminate only if it lingers past the grace window after the stream ended.
  const graceTimer = setTimeout(() => { kill(); }, killGraceMs);
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    processLifecycle,
    new Promise<void>(resolve => {
      reapTimer = setTimeout(resolve, reapTimeoutMs);
    }),
  ]);
  clearTimeout(graceTimer);
  if (reapTimer) clearTimeout(reapTimer);
  if (killTimer) clearTimeout(killTimer);
  await removeTemporaryFiles();

  if (!terminalEmitted && !captureCommitted) {
    const stderr = redactSecrets(boundedStderr(stderrChunks), profile.tokenEnv, apiKey);
    if (incoming.abortSignal?.aborted) {
      emitOnce({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
    } else if (childProcessError) {
      emitOnce({
        type: "error",
        message: `${profile.label} CLI failed to start: ${redactSecrets(childProcessError.message, profile.tokenEnv, apiKey)}`,
        status: 500,
        errorType: "upstream_error",
        code: "cli_spawn_failed",
        retryable: false,
      });
    } else if (turnError) {
      emitOnce({
        type: "error",
        message: redactSecrets(turnError, profile.tokenEnv, apiKey),
        status: 502,
        errorType: "upstream_error",
      });
    } else if (streamProtocolError) {
      emitOnce({
        type: "error",
        message: redactSecrets(streamProtocolError, profile.tokenEnv, apiKey),
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
    } else if (child.exitCode !== null && child.exitCode !== 0) {
      const exitMsg = stderr
        ? `${profile.label} CLI exited with code ${child.exitCode}: ${stderr}`
        : `${profile.label} CLI exited with non-zero exit code ${child.exitCode}`;
      emitOnce({
        type: "error",
        message: exitMsg,
        status: 502,
        errorType: "upstream_error",
        code: "process_exit_error",
        retryable: false,
      });
    } else if (toolBridge?.captureMode !== "side-channel" && toolBridge && deferredResultDone && !state.sawMessageStop) {
      emitOnce({ type: "error", message: `${profile.label} CLI delivered a terminal result before message_stop on a tool-bridge turn.`, status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
    } else if (toolBridge?.captureMode === "side-channel" && (nativeToolCall !== undefined || capturedToolCalls.length > 0)) {
      // Side-channel fail-closed: one join half arrived but the other never did. Never emit a
      // partial tool call and never synthesize the missing id.
      const missing = nativeToolCall === undefined
        ? "the native tool-use identity was never streamed"
        : "a matching MCP capture record never arrived";
      emitOnce({
        type: "error",
        message: `Coding-agent side-channel tool capture is incomplete: ${missing}.`,
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
    } else if (!state.sawTerminalResult) {
      const msg = stderr
        ? `${profile.label} CLI ended without a terminal result frame: ${stderr}`
        : `${profile.label} CLI ended without a terminal result frame`;
      emitOnce({
        type: "error",
        message: msg,
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
    }
  }
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

function boundedStderr(chunks: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (const chunk of chunks) {
    if (total >= MAX_STDERR_BYTES) break;
    kept.push(chunk);
    total += chunk.length;
  }
  return kept.join("").slice(0, MAX_STDERR_BYTES).trim();
}
