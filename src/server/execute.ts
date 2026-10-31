import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import type { AcpxEngineExecutorOptions, AcpxEngineBillingIdentity } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MISTRAL_VIBE_MODEL } from "../index.js";
import { ensureMistralVibeSkillsLinked } from "./skills.js";
import {
  MISTRAL_API_KEY_ENV_VAR,
  ensureVibeConfigModel,
  ensureVibeHomeDir,
  ensureVibeTrustedFolder,
  resolveVibeAcpCommand,
  resolveVibeHome,
} from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");

type MistralVibeAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir" | "resolveBillingIdentity"
>;

type MistralVibeAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export interface BuildMistralVibeAcpConfigInput {
  config: Record<string, unknown>;
  companyId: string;
  agentId: string;
  /** Resolved absolute path (or PATH-resolvable command) of the vibe-acp binary. */
  vibeAcpCommand: string;
  /** Resolved absolute per-agent VIBE_HOME directory. */
  vibeHome: string;
  /** Run working directory, used for the trust-store seed. */
  cwd: string;
}

/**
 * Build the config handed to the shared ACP engine. The adapter is thin by
 * design: it pins the engine to `custom` + the resolved vibe-acp command,
 * forces a per-agent VIBE_HOME, merges the agent's env (including
 * MISTRAL_API_KEY) over the defaults, and strips the effort/fast-mode keys
 * that vibe-acp rejects as unsupported config options.
 */
export function buildMistralVibeAcpConfig(input: BuildMistralVibeAcpConfigInput): Record<string, unknown> {
  const { config, vibeAcpCommand, vibeHome } = input;
  const mode = firstNonEmptyString(config.mode) ?? DEFAULT_ACP_ENGINE_MODE;
  const permissionMode =
    firstNonEmptyString(config.permissionMode) ?? DEFAULT_ACP_ENGINE_PERMISSION_MODE;
  const nonInteractivePermissions =
    firstNonEmptyString(config.nonInteractivePermissions) ??
    DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS;
  const warmHandleIdleMs =
    config.warmHandleIdleMs ?? DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS;

  const configuredEnv = parseObject(config.env);
  const env: Record<string, unknown> = {
    ...configuredEnv,
    VIBE_HOME: vibeHome,
  };

  const next: Record<string, unknown> = {
    ...config,
    agent: "custom",
    agentCommand: vibeAcpCommand,
    mode,
    permissionMode,
    nonInteractivePermissions,
    warmHandleIdleMs,
    env,
    coalescePlaceholderToolUpdates: true,
  };

  const model = asString(next.model, "").trim();
  if (!model || model === DEFAULT_MISTRAL_VIBE_MODEL) delete next.model;

  // vibe-acp advertises only `model`, `mode`, `thinking`, `max_turns` and
  // `max_tokens` config options; anything else (notably `effort`) is rejected
  // with InvalidRequestError and fails the session. Drop every effort /
  // fast-mode key so the engine never sends them.
  delete next.effort;
  delete next.thinkingEffort;
  delete next.reasoningEffort;
  delete next.modelReasoningEffort;
  delete next.fastMode;

  // vibeAcpPath/vibeHome are adapter-side inputs, not engine config keys.
  delete next.vibeAcpPath;
  delete next.vibeHome;
  delete next.vibeAuthProbe;

  return next;
}

function resolveBillingIdentity(): AcpxEngineBillingIdentity {
  // Keys come from Code › Vibe CLI in the Mistral console; usage draws from
  // the plan's included quota first (pay-as-you-go is off by default).
  return { provider: "mistral", biller: "mistral", billingType: "subscription" };
}

function withMistralVibeAcpDefaults(
  options: MistralVibeAcpExecutorOptions,
): AcpxEngineExecutorOptions {
  return {
    ...options,
    adapterType: "mistral_vibe",
    moduleDir,
    packageRootDir,
    resolveBillingIdentity,
  };
}

/**
 * Run working directory: the Paperclip workspace cwd when present, else the
 * configured cwd, else the process cwd.
 */
export function resolveRunCwd(ctx: AdapterExecutionContext): string {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "").trim();
  if (workspaceCwd) return path.resolve(workspaceCwd);
  const configuredCwd = asString(ctx.config.cwd, "").trim();
  if (configuredCwd) return path.resolve(configuredCwd);
  return process.cwd();
}

export function createMistralVibeAcpExecutor(
  options: MistralVibeAcpExecutorOptions = {},
): MistralVibeAcpExecutor {
  let executor: MistralVibeAcpExecutor | null = null;
  return async (ctx) => {
    const { command } = await resolveVibeAcpCommand(ctx.config);
    const vibeHome = resolveVibeHome(ctx.config, ctx.agent.companyId, ctx.agent.id);
    const cwd = resolveRunCwd(ctx);
    await ensureVibeHomeDir(vibeHome);
    const model = asString(ctx.config.model, DEFAULT_MISTRAL_VIBE_MODEL).trim() || DEFAULT_MISTRAL_VIBE_MODEL;
    await ensureVibeConfigModel(vibeHome, model);
    await ensureVibeTrustedFolder(vibeHome, cwd);
    await ensureMistralVibeSkillsLinked(ctx.config, ctx.agent.companyId, ctx.agent.id, ctx.onLog);

    let currentExecutor = executor;
    if (!currentExecutor) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      currentExecutor = createAcpxEngineExecutor(withMistralVibeAcpDefaults(options));
      executor = currentExecutor;
    }
    return currentExecutor({
      ...ctx,
      config: buildMistralVibeAcpConfig({
        config: ctx.config,
        companyId: ctx.agent.companyId,
        agentId: ctx.agent.id,
        vibeAcpCommand: command,
        vibeHome,
        cwd,
      }),
    });
  };
}

export { MISTRAL_API_KEY_ENV_VAR };
