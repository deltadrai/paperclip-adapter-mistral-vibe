import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  MISTRAL_API_KEY_ENV_VAR,
  VIBE_ACP_ENV_VAR,
  configHasMistralApiKey,
  ensureVibeHomeDir,
  pathIsExecutable,
  resolveVibeAcpCommand,
  resolveVibeHome,
} from "./config.js";

/** The shared ACP engine (via @paperclipai/adapter-utils) requires Node >= 24.11. */
const MIN_ACP_NODE_VERSION = "24.11.0";
const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";
const AUTH_PROBE_TIMEOUT_MS = 5000;

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionMeetsAcpMinimum(version = process.version): boolean {
  const [major, minor, patch] = parseVersion(version);
  const [minMajor, minMinor, minPatch] = parseVersion(MIN_ACP_NODE_VERSION);
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function firstShellToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("'") || trimmed.startsWith("\"")) return null;
  return trimmed.split(/\s+/, 1)[0] ?? null;
}

function resolveConfigPath(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  const configured = asString(envConfig.PATH, "").trim();
  return configured.length > 0 ? configured : process.env.PATH ?? "";
}

async function findCommandOnPath(binName: string, pathValue: string): Promise<string | null> {
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, binName);
    if (await pathIsExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Local-lane resolvability: an absolute/relative path must exist and be
 * executable; a bare command must be found on the config/env PATH.
 */
async function commandIsResolvableLocally(command: string, pathValue: string): Promise<boolean> {
  const token = firstShellToken(command);
  if (!token) return true;
  if (path.isAbsolute(token) || hasPathSeparator(token)) return pathIsExecutable(token);
  return (await findCommandOnPath(token, pathValue)) !== null;
}

async function commandIsResolvable(
  command: string,
  pathValue: string,
  ctx: AdapterEnvironmentTestContext,
): Promise<boolean> {
  const token = firstShellToken(command);
  if (!token) return true;
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: undefined,
  });
  if (target?.kind === "remote") {
    try {
      await ensureAdapterExecutionTargetCommandResolvable(
        token,
        target,
        resolveAdapterExecutionTargetCwd(target, asString(ctx.config.cwd, ""), process.cwd()),
        process.env,
      );
      return true;
    } catch {
      return false;
    }
  }
  return commandIsResolvableLocally(token, pathValue);
}

async function probeVersion(
  ctx: AdapterEnvironmentTestContext,
  command: string,
): Promise<{ version: string | null; detail?: string }> {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: undefined,
  });
  const token = firstShellToken(command);
  if (!token) return { version: null, detail: "Empty command." };
  try {
    const result = await runAdapterExecutionTargetProcess("adapter-env-test", target, token, ["--version"], {
      cwd: resolveAdapterExecutionTargetCwd(target, asString(ctx.config.cwd, ""), process.cwd()),
      env: process.env as Record<string, string>,
      timeoutSec: 15,
      graceSec: 2,
      onLog: async () => {},
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    if (result.exitCode === 0 && match) {
      return { version: match[1] };
    }
    return {
      version: null,
      detail: `Exit code ${result.exitCode ?? "unknown"}: ${output.trim().slice(0, 300)}`,
    };
  } catch (err) {
    return { version: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function vibeHomeHasKey(vibeHome: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(vibeHome, ".env"), "utf8");
    return new RegExp(`^${MISTRAL_API_KEY_ENV_VAR}\\s*=\\s*\\S+`, "m").test(raw);
  } catch {
    return false;
  }
}

/**
 * Cheap live auth probe against the Mistral API. Never sends or logs the key
 * value; only the HTTP status is reported.
 */
async function probeMistralAuth(key: string): Promise<{ status: number | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(MISTRAL_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    return { status: response.status };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const envLabel = ctx.environmentName ? ` (${ctx.environmentName})` : "";

  checks.push({
    code: "mistral_vibe_engine_selected",
    level: "info",
    message: `Execution engine selected: ACP (vibe-acp) via the shared Paperclip ACP engine${envLabel}.`,
  });

  // Node runtime requirement of the shared ACP engine.
  const nodeOk = nodeVersionMeetsAcpMinimum();
  checks.push({
    code: nodeOk ? "mistral_vibe_node_supported" : "mistral_vibe_node_unsupported",
    level: nodeOk ? "info" : "error",
    message: nodeOk
      ? `Node ${process.version} satisfies the ACP engine requirement (>=${MIN_ACP_NODE_VERSION}).`
      : `Node ${process.version} does not satisfy the ACP engine requirement (>=${MIN_ACP_NODE_VERSION}).`,
    hint: nodeOk ? undefined : `Run Paperclip with Node >=${MIN_ACP_NODE_VERSION}.`,
  });

  // vibe-acp binary resolvable.
  const resolved = await resolveVibeAcpCommand(config);
  const commandResolvable = await commandIsResolvable(resolved.command, resolveConfigPath(config), ctx);
  checks.push({
    code: commandResolvable ? "mistral_vibe_binary_resolvable" : "mistral_vibe_binary_missing",
    level: commandResolvable ? "info" : "error",
    message: commandResolvable
      ? `vibe-acp command is available: ${resolved.command} (source: ${resolved.source})`
      : `vibe-acp command is not available: ${resolved.command} (source: ${resolved.source})`,
    hint: commandResolvable
      ? undefined
      : `Install the standalone vibe-acp binary (see README) and set vibeAcpPath in the agent config or ${VIBE_ACP_ENV_VAR} in the server environment.`,
  });

  // Version probe (local lane only; remote targets are probed by the resolvability check).
  if (commandResolvable && !targetIsRemote) {
    const version = await probeVersion(ctx, resolved.command);
    checks.push({
      code: version.version ? "mistral_vibe_binary_version" : "mistral_vibe_binary_version_failed",
      level: version.version ? "info" : "warn",
      message: version.version
        ? `vibe-acp version reported: ${version.version}`
        : "vibe-acp did not report a version with --version.",
      detail: version.detail ?? undefined,
      hint: version.version
        ? undefined
        : "Verify the binary is the standalone vibe-acp release (not a wrapper script).",
    });
  }

  // VIBE_HOME resolvable and writable.
  const vibeHome = resolveVibeHome(config, ctx.companyId, "env-test");
  try {
    await ensureVibeHomeDir(vibeHome);
    const probeFile = path.join(vibeHome, ".paperclip-write-probe");
    await fs.writeFile(probeFile, "ok", "utf8");
    await fs.rm(probeFile, { force: true });
    checks.push({
      code: "mistral_vibe_home_writable",
      level: "info",
      message: `VIBE_HOME is writable: ${vibeHome}`,
    });
  } catch (err) {
    checks.push({
      code: "mistral_vibe_home_not_writable",
      level: "error",
      message: `VIBE_HOME is not writable: ${vibeHome}`,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Set vibeHome in the agent config to a writable absolute directory, or fix permissions on the default per-agent directory.",
    });
  }

  // Credential presence (never the value). Agent env wins; $VIBE_HOME/.env is
  // the fallback Vibe itself uses.
  const envConfig = parseObject(config.env);
  const keyFromConfig = configHasMistralApiKey(config);
  const keyFromDotEnv = !keyFromConfig && !targetIsRemote ? await vibeHomeHasKey(vibeHome) : false;
  if (keyFromConfig) {
    checks.push({
      code: "mistral_vibe_api_key_present",
      level: "info",
      message: "MISTRAL_API_KEY is set in the agent's adapter env.",
    });
  } else if (keyFromDotEnv) {
    checks.push({
      code: "mistral_vibe_api_key_present",
      level: "info",
      message: `MISTRAL_API_KEY is set in ${path.join(vibeHome, ".env")}.`,
    });
  } else {
    checks.push({
      code: ADAPTER_AUTH_MISSING_CHECK_CODE,
      level: "error",
      message: "No MISTRAL_API_KEY found for this agent.",
      hint: "Add MISTRAL_API_KEY to the agent's adapter env (a Paperclip secret reference is supported). Create the key under Code › Vibe CLI in the Mistral console.",
    });
  }

  // Optional live auth probe (default on; disable with vibeAuthProbe=false).
  const authProbeEnabled = config.vibeAuthProbe !== false;
  const keyValue = typeof envConfig[MISTRAL_API_KEY_ENV_VAR] === "string"
    ? (envConfig[MISTRAL_API_KEY_ENV_VAR] as string).trim()
    : "";
  if (authProbeEnabled && keyValue && !targetIsRemote) {
    const probe = await probeMistralAuth(keyValue);
    if (probe.status === 200) {
      checks.push({
        code: "mistral_vibe_auth_probe_ok",
        level: "info",
        message: "Live probe: Mistral API accepted the key (GET /v1/models → 200).",
      });
    } else if (probe.status === 401 || probe.status === 403) {
      checks.push({
        code: "mistral_vibe_auth_probe_rejected",
        level: "error",
        message: `Live probe: Mistral API rejected the key (GET /v1/models → ${probe.status}).`,
        hint: "Check that the key is a Code › Vibe CLI key from the Mistral console and has not been revoked.",
      });
    } else {
      checks.push({
        code: "mistral_vibe_auth_probe_unreachable",
        level: "warn",
        message: "Live probe skipped: Mistral API unreachable.",
        detail: probe.error ?? `HTTP status ${probe.status ?? "none"}`,
        hint: "Set vibeAuthProbe=false in the agent config to silence this check.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
