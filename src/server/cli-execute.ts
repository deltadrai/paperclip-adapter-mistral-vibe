import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asString,
  joinPromptSections,
  parseObject,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MISTRAL_VIBE_MODEL } from "../index.js";
import { resolveRunCwd } from "./execute.js";
import {
  type CliAgentProfile,
  ensureVibeConfigModel,
  ensureVibeHomeDir,
  ensureVibeTrustedFolder,
  resolveCliAgent,
  resolveVibeCliCommand,
  resolveVibeHome,
} from "./config.js";

// ---------------------------------------------------------------------------
// Per-agent session state (resume id store)
// ---------------------------------------------------------------------------

const SESSION_STATE_FILE = "paperclip-cli-session.json";

/**
 * The vibe session id this agent should resume. Stored inside the agent's own
 * VIBE_HOME so isolation matches the ACP lane; vibe keeps the id stable across
 * --resume runs.
 */
export async function readCliSessionState(vibeHome: string): Promise<{ sessionId: string | null }> {
  try {
    const raw = await fs.readFile(path.join(vibeHome, SESSION_STATE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const sessionId =
      typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).sessionId === "string"
        ? ((parsed as Record<string, unknown>).sessionId as string)
        : null;
    return { sessionId: sessionId && sessionId.length > 0 ? sessionId : null };
  } catch {
    return { sessionId: null };
  }
}

/** Persist (or, with null, clear) the resume id. */
export async function writeCliSessionState(vibeHome: string, sessionId: string | null): Promise<void> {
  const statePath = path.join(vibeHome, SESSION_STATE_FILE);
  if (sessionId === null) {
    await fs.rm(statePath, { force: true });
    return;
  }
  await fs.writeFile(statePath, JSON.stringify({ sessionId }, null, 2), { encoding: "utf8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// export.json parsing
// ---------------------------------------------------------------------------

export interface VibeCliExportSummary {
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  costUsd: number | null;
  outcome: string | null;
  stopReason: string | null;
  exitCode: number | null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse vibe's per-run export.json into adapter-facing usage fields. */
export function parseVibeCliExport(raw: string): VibeCliExportSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const usage = typeof record.usage === "object" && record.usage !== null ? (record.usage as Record<string, unknown>) : {};
  return {
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
    usage: {
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedInputTokens: asNumber(usage.cached_input_tokens),
    },
    costUsd: typeof record.cost_usd === "number" && Number.isFinite(record.cost_usd) ? record.cost_usd : null,
    outcome: typeof record.outcome === "string" ? record.outcome : null,
    stopReason: typeof record.stop_reason === "string" ? record.stop_reason : null,
    exitCode: typeof record.exit_code === "number" ? record.exit_code : null,
  };
}

// ---------------------------------------------------------------------------
// Streaming stdout parser (vibe -p --output streaming)
// ---------------------------------------------------------------------------

/** excerpt limit for tool output shown in the run transcript */
const TOOL_OUTPUT_EXCERPT_CHARS = 2000;

export interface VibeCliStreamState {
  sessionId: string | null;
  lastAssistantText: string | null;
  approvalsDenied: number;
}

export interface VibeCliStreamParser {
  state: VibeCliStreamState;
  /** Returns the transcript lines to emit for one stdout line (0..n). */
  parseLine(line: string): string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") return record.text;
  }
  return null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerpt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > TOOL_OUTPUT_EXCERPT_CHARS
    ? `${trimmed.slice(0, TOOL_OUTPUT_EXCERPT_CHARS)}… (${trimmed.length} chars, truncated)`
    : trimmed;
}

function toolHeadline(detail: Record<string, unknown> | null, title: string): string {
  const display = asRecord(detail?.display);
  const summary = typeof display?.summary === "string" ? display.summary : title;
  return singleLine(summary);
}

/**
 * Parse `vibe -p --output streaming` NDJSON. Emits readable transcript lines
 * for assistant messages, settled tool effects, and approval callbacks; user
 * echoes and reasoning entries are skipped (reasoning stays private, and the
 * user prompt would duplicate Paperclip's own prompt). Non-JSON lines (vibe
 * notices, warnings) pass through unchanged so nothing is silently lost.
 */
export function createVibeCliStreamParser(): VibeCliStreamParser {
  const state: VibeCliStreamState = {
    sessionId: null,
    lastAssistantText: null,
    approvalsDenied: 0,
  };
  const emittedEffects = new Set<string>();

  return {
    state,
    parseLine(line: string): string[] {
      const trimmed = line.trim();
      if (trimmed.length === 0) return [];
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        entry = asRecord(parsed) ?? {};
      } catch {
        return [line];
      }

      if (typeof entry.sessionId === "string" && entry.sessionId.length > 0) {
        state.sessionId = entry.sessionId;
      }

      if (entry.type === "message") {
        if (entry.role === "assistant") {
          const text = firstText(entry.content);
          if (text !== null) {
            state.lastAssistantText = text;
            return [text];
          }
        }
        return [];
      }

      if (entry.type === "callback") {
        const detail = asRecord(entry.detail);
        if (detail?.kind !== "approval") return [];
        const decision = asRecord(asRecord(entry.state)?.output)?.decision;
        if (asRecord(decision)?.type !== "deny") return [];
        state.approvalsDenied += 1;
        const effect = asRecord(detail.effect);
        const toolName = typeof effect?.toolName === "string" ? effect.toolName : "a tool";
        return [
          `[paperclip] ${toolName} needs approval — auto-denied (the vibe CLI lane cannot prompt; ` +
            `use an approving agent profile or the vibe-acp ACP lane for interactive approval).`,
        ];
      }

      if (entry.type === "effect") {
        const id = typeof entry.id === "string" ? entry.id : "";
        if (id.length === 0 || emittedEffects.has(id)) return [];
        const effectState = asRecord(entry.state);
        const status = effectState?.status;
        if (status !== "completed" && status !== "failed") return [];
        emittedEffects.add(id);
        const detail = asRecord(entry.detail);
        const headline = toolHeadline(detail, typeof entry.title === "string" ? entry.title : "tool");
        if (status === "failed") {
          const error = asRecord(effectState?.error);
          const message =
            typeof error?.message === "string" ? singleLine(error.message) : "tool call failed";
          return [`[tool] ${headline} — FAILED: ${message}`];
        }
        const outputText = typeof effectState?.outputText === "string" ? effectState.outputText : "";
        const out = excerpt(outputText);
        return out.length > 0 ? [`[tool] ${headline}`, out] : [`[tool] ${headline}`];
      }

      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------

export interface VibeCliArgsInput {
  /** Absolute path of the file holding the rendered run prompt. */
  promptFilePath: string;
  /** Run working directory. */
  cwd: string;
  /** Per-run directory that receives vibe's export.json + session journal copy. */
  outputDir: string;
  /** Vibe session id to resume, or null for a fresh session. */
  resumeSessionId: string | null;
  /** Tool-approval agent profile. */
  agent: CliAgentProfile;
}

/**
 * Build the `vibe -p` argument vector. The prompt travels via --prompt-file
 * (argv length limits, quoting), tool approvals are decided up front by the
 * --agent profile (a non-interactive run cannot answer approval callbacks),
 * and --trust skips the interactive workspace-trust prompt for this
 * invocation only. Timeouts are enforced by the adapter, not --time-limit.
 */
export function buildVibeCliArgs(input: VibeCliArgsInput): string[] {
  const args = [
    "-p",
    "--prompt-file",
    input.promptFilePath,
    "--output",
    "streaming",
    "--agent",
    input.agent,
    "--trust",
    "--workdir",
    input.cwd,
    "--output-dir",
    input.outputDir,
  ];
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export interface VibeCliPromptInput {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  agent: { id: string; companyId: string; name?: unknown };
  runId: string;
  resumedSession: boolean;
  instructions: string | null;
}

/**
 * Assemble the run prompt the same way the codex CLI lane does: template
 * (config override or Paperclip default), wake sections, communication
 * guidance on fresh sessions, and the agent instructions bundle. On a
 * resumed session with a wake payload the template is skipped (wake delta).
 */
export function buildVibeCliPrompt(input: VibeCliPromptInput): string {
  const { config, context, agent, runId, resumedSession, instructions } = input;
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession,
    includeCommunicationGuidance: false,
  });
  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  return joinPromptSections([
    instructions,
    shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData),
    shouldUseResumeDeltaPrompt
      ? ""
      : selectInitialCommunicationGuidance(context, { resumedSession }),
    wakePrompt,
    taskContextNote,
  ]);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const STDERR_TAIL_CHARS = 2000;

interface CliAttemptOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage: string | null;
  summary: VibeCliExportSummary | null;
  parser: VibeCliStreamParser;
  killed: boolean;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already gone.
    }
  }
}

async function runCliAttempt(input: {
  ctx: AdapterExecutionContext;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutSec: number;
  graceSec: number;
  runDir: string;
}): Promise<CliAttemptOutcome> {
  const { ctx, command, args, env, cwd, timeoutSec, graceSec, runDir } = input;
  const parser = createVibeCliStreamParser();
  let stderrTail = "";
  let timedOut = false;
  let killed = false;

  const promptMetrics: AdapterInvocationMeta = {
    adapterType: "mistral_vibe",
    command,
    commandArgs: args,
    cwd,
    env,
  };
  await ctx.onMeta?.(promptMetrics);
  await ctx.onDispatch?.();

  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await ctx.onSpawn?.({
    pid: child.pid ?? -1,
    processGroupId: child.pid ?? null,
    startedAt: new Date().toISOString(),
  });

  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      void (async () => {
        for (const emitted of parser.parseLine(line)) {
          await ctx.onLog("stdout", `${emitted}\n`);
        }
      })().catch(() => {});
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    void ctx.onLog("stderr", chunk).catch(() => {});
  });

  let timeoutTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  const armTimeout = (): void => {
    if (timeoutSec <= 0) return;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killProcessGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), Math.max(graceSec, 0) * 1000);
    }, timeoutSec * 1000);
  };
  armTimeout();
  const abortListener = (): void => {
    if (killed) return;
    killed = true;
    killProcessGroup(child, "SIGTERM");
    graceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), Math.max(graceSec, 0) * 1000);
  };
  ctx.signal?.addEventListener("abort", abortListener, { once: true });

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (graceTimer) clearTimeout(graceTimer);
  ctx.signal?.removeEventListener("abort", abortListener);

  const flush = stdoutBuffer.trim();
  if (flush.length > 0) {
    for (const emitted of parser.parseLine(flush)) {
      await ctx.onLog("stdout", `${emitted}\n`);
    }
  }

  let summary: VibeCliExportSummary | null = null;
  try {
    const raw = await fs.readFile(path.join(runDir, "export.json"), "utf8");
    summary = parseVibeCliExport(raw);
  } catch {
    summary = null;
  }

  const errorMessage =
    timedOut
      ? `vibe CLI run timed out after ${timeoutSec}s.`
      : exitInfo.code !== 0 && exitInfo.code !== null
        ? stderrTail.trim().slice(-STDERR_TAIL_CHARS) || `vibe CLI exited with code ${exitInfo.code}.`
        : exitInfo.code === null && killed
          ? "vibe CLI run was stopped before completion."
          : null;

  return {
    exitCode: exitInfo.code,
    signal: exitInfo.signal ?? (killed ? "SIGTERM" : null),
    timedOut,
    errorMessage,
    summary,
    parser,
    killed,
  };
}

/**
 * Execute one Paperclip run with `vibe -p`. Per-agent state (VIBE_HOME,
 * config.toml model, trusted folders) matches the ACP lane; the resume id is
 * persisted in the agent's VIBE_HOME, and a failed resume falls back to a
 * fresh session once.
 */
export function createMistralVibeCliExecutor(): (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> {
  return async (ctx) => {
    const { config, agent, runId } = ctx;
    const { command } = await resolveVibeCliCommand(config);
    const vibeHome = resolveVibeHome(config, agent.companyId, agent.id);
    const cwd = resolveRunCwd(ctx);
    await ensureVibeHomeDir(vibeHome);
    const model = asString(config.model, DEFAULT_MISTRAL_VIBE_MODEL).trim() || DEFAULT_MISTRAL_VIBE_MODEL;
    await ensureVibeConfigModel(vibeHome, model);
    await ensureVibeTrustedFolder(vibeHome, cwd);
    const agentProfile = resolveCliAgent(config);

    const configuredEnv = parseObject(config.env);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...configuredEnv,
      VIBE_HOME: vibeHome,
    };

    const timeoutSec = typeof config.timeoutSec === "number" && config.timeoutSec > 0 ? config.timeoutSec : 0;
    const graceSec = typeof config.graceSec === "number" && config.graceSec >= 0 ? config.graceSec : 5;

    let instructions: string | null = null;
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    if (instructionsFilePath.length > 0) {
      try {
        instructions = await fs.readFile(instructionsFilePath, "utf8");
      } catch (err) {
        await ctx.onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    const storedSessionId =
      config.cliFreshSession === true ? null : (await readCliSessionState(vibeHome)).sessionId;

    const attempt = async (resumeSessionId: string | null): Promise<CliAttemptOutcome> => {
      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `vibe-cli-${runId}-`));
      try {
        const prompt = buildVibeCliPrompt({
          config,
          context: ctx.context ?? {},
          agent,
          runId,
          resumedSession: resumeSessionId !== null,
          instructions,
        });
        const promptFilePath = path.join(runDir, "prompt.md");
        await fs.writeFile(promptFilePath, prompt, { encoding: "utf8", mode: 0o600 });
        const args = buildVibeCliArgs({
          promptFilePath,
          cwd,
          outputDir: runDir,
          resumeSessionId,
          agent: agentProfile,
        });
        return await runCliAttempt({ ctx, command, args, env, cwd, timeoutSec, graceSec, runDir });
      } finally {
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    };

    let outcome = await attempt(storedSessionId);
    if (storedSessionId !== null && outcome.exitCode !== 0) {
      await ctx.onLog(
        "stdout",
        `[paperclip] vibe CLI failed while resuming session ${storedSessionId} — retrying with a fresh session.\n`,
      );
      await writeCliSessionState(vibeHome, null);
      outcome = await attempt(null);
    }

    const parserSessionId = outcome.parser.state.sessionId;
    const sessionId = outcome.summary?.sessionId ?? parserSessionId;
    if (outcome.exitCode === 0 && sessionId) {
      await writeCliSessionState(vibeHome, sessionId);
    }

    const result: AdapterExecutionResult = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      errorMessage: outcome.errorMessage,
      errorCode: outcome.exitCode !== 0 && outcome.exitCode !== null ? "vibe_cli_exit" : null,
      provider: "mistral",
      biller: "mistral",
      billingType: "subscription",
      model,
      sessionId,
      summary: outcome.parser.state.lastAssistantText,
    };
    if (outcome.summary) {
      result.usage = {
        inputTokens: outcome.summary.usage.inputTokens,
        outputTokens: outcome.summary.usage.outputTokens,
        cachedInputTokens: outcome.summary.usage.cachedInputTokens,
      };
      result.usageBasis = "per_run";
      result.costUsd = outcome.summary.costUsd;
      result.costStatus = outcome.summary.costUsd !== null ? "reported" : "unpriced";
    }
    if (outcome.parser.state.approvalsDenied > 0) {
      result.resultJson = { approvalsDenied: outcome.parser.state.approvalsDenied };
    }
    return result;
  };
}
