import type {
  AdapterConfigSchema,
  AdapterExecutionContext,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import {
  DEFAULT_MISTRAL_VIBE_MODEL,
  agentConfigurationDoc,
  models,
  type,
} from "../index.js";
import { CLI_AGENT_PROFILES, resolveExecutionEngine } from "./config.js";
import { createMistralVibeAcpExecutor } from "./execute.js";
import { createMistralVibeCliExecutor } from "./cli-execute.js";
import {
  detectMistralVibeModel,
  listMistralVibeModels,
  refreshMistralVibeModels,
} from "./models.js";
import { getQuotaWindows } from "./quota.js";
import { listMistralVibeSkills, syncMistralVibeSkills } from "./skills.js";
import { testEnvironment } from "./test.js";

const acpExecutor = createMistralVibeAcpExecutor();
const cliExecutor = createMistralVibeCliExecutor();

async function execute(ctx: AdapterExecutionContext) {
  return resolveExecutionEngine(ctx.config) === "cli" ? cliExecutor(ctx) : acpExecutor(ctx);
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec: acpxSessionCodec,
    models,
    agentConfigurationDoc,
    acp: {
      agentId: "custom",
      skillsMode: "ephemeral",
      prerequisites: {},
    },
    listSkills: listMistralVibeSkills,
    syncSkills: syncMistralVibeSkills,
    requiresMaterializedRuntimeSkills: true,
    listModels: listMistralVibeModels,
    refreshModels: refreshMistralVibeModels,
    detectModel: detectMistralVibeModel,
    runtimeToolDelivery: "environment",
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    supportsLocalAgentJwt: true,
    getQuotaWindows,
    getConfigSchema(): AdapterConfigSchema {
      return {
        fields: [
          {
            key: "model",
            label: "Model",
            type: "combobox",
            default: DEFAULT_MISTRAL_VIBE_MODEL,
            options: (models as AdapterModel[]).map((model) => ({
              label: model.label,
              value: model.id,
            })),
            hint: "Mistral API model id (Code › Vibe CLI compatible).",
            group: "Agent",
          },
          {
            key: "engine",
            label: "Execution engine",
            type: "select",
            default: "acp",
            options: [
              { value: "acp", label: "vibe-acp (ACP server)" },
              { value: "cli", label: "vibe CLI (vibe -p)" },
            ],
            hint: "acp runs the standalone vibe-acp binary through the shared ACP engine (interactive approval supported). cli runs the vibe CLI headless: one vibe -p process per run, sessions resume via --resume, and tool approvals are decided up front by the agent profile.",
            group: "Runtime",
          },
          {
            key: "vibeAcpPath",
            label: "vibe-acp binary path",
            type: "text",
            hint: "Absolute path to the standalone vibe-acp binary. Falls back to PAPERCLIP_VIBE_ACP_PATH, then vibe-acp on PATH.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "acp" } },
          },
          {
            key: "vibeCliPath",
            label: "vibe CLI path",
            type: "text",
            hint: "Absolute path to the vibe binary. Falls back to PAPERCLIP_VIBE_CLI_PATH, then vibe on PATH.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "cli" } },
          },
          {
            key: "cliAgent",
            label: "CLI approval profile",
            type: "select",
            default: "auto-approve",
            options: CLI_AGENT_PROFILES.map((profile) => ({ value: profile, label: profile })),
            hint: "vibe -p cannot ask for approval mid-run: unanswered approval callbacks are auto-denied. auto-approve executes everything; smart-approve auto-runs safe calls only.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "cli" } },
          },
          {
            key: "cliFreshSession",
            label: "Start a fresh CLI session",
            type: "toggle",
            default: false,
            hint: "Skip the stored resume id and start a new vibe session on the next run.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "cli" } },
          },
          {
            key: "mode",
            label: "ACP session mode",
            type: "select",
            default: DEFAULT_ACP_ENGINE_MODE,
            options: [
              { value: "persistent", label: "Persistent" },
              { value: "oneshot", label: "One-shot" },
            ],
            hint: "Persistent keeps ACP session state between runs. One-shot starts fresh each run.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "acp" } },
          },
          {
            key: "permissionMode",
            label: "ACP permission mode",
            type: "select",
            default: DEFAULT_ACP_ENGINE_PERMISSION_MODE,
            options: [
              { value: "approve-all", label: "Approve all" },
              { value: "manual", label: "Manual" },
            ],
            hint: "How the ACP engine answers vibe-acp permission requests.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "acp" } },
          },
          {
            key: "nonInteractivePermissions",
            label: "ACP non-interactive permissions",
            type: "select",
            default: DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
            options: [
              { value: "deny", label: "Deny" },
              { value: "approve-all", label: "Approve all" },
            ],
            hint: "Fallback if the ACP agent asks for input outside an interactive session.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "acp" } },
          },
          {
            key: "warmHandleIdleMs",
            label: "ACP warm handle idle (ms)",
            type: "number",
            default: DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
            hint: "How long an idle agent process stays warm between runs.",
            group: "Runtime",
            meta: { visibleWhen: { key: "engine", value: "acp" } },
          },
          {
            key: "vibeHome",
            label: "VIBE_HOME override",
            type: "text",
            hint: "Optional absolute directory for this agent's Vibe state. Defaults to a per-agent directory under the Paperclip instance root.",
            group: "Runtime",
          },
          {
            key: "vibeAuthProbe",
            label: "Live auth probe",
            type: "toggle",
            default: true,
            hint: "When enabled, the environment test performs a live GET https://api.mistral.ai/v1/models with the agent's key.",
            group: "Runtime",
          },
          {
            key: "timeoutSec",
            label: "Run timeout (seconds)",
            type: "number",
            hint: "0 = no timeout. ACP: engine-enforced; CLI: SIGTERM to the vibe process group, SIGKILL after the grace period.",
            group: "Runtime",
          },
          {
            key: "graceSec",
            label: "Stop grace period (seconds)",
            type: "number",
            default: 5,
            hint: "Seconds between SIGTERM and SIGKILL when a run is stopped or times out.",
            group: "Runtime",
          },
          {
            key: "env",
            label: "Environment variables",
            type: "textarea",
            hint: "KEY=VALUE lines. Set MISTRAL_API_KEY here (a Paperclip secret reference is supported). VIBE_HOME is always set per agent by the adapter.",
            group: "Runtime",
          },
          {
            key: "quotaWindowsNote",
            label: "Quota dashboard",
            type: "toggle",
            default: false,
            hint: "Read-only. Live Vibe quota windows appear when the Paperclip server has MISTRAL_ADMIN_API_KEY set (Mistral Admin API, Enterprise plans only). Not configurable per agent.",
            group: "Quota",
            meta: { readOnly: true },
          },
        ],
      };
    },
  };
}

export { execute };
export { getQuotaWindows };
export { testEnvironment };
export { acpxSessionCodec as sessionCodec };
