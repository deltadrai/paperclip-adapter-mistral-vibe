import type {
  AdapterConfigSchema,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import {
  DEFAULT_MISTRAL_VIBE_MODEL,
  agentConfigurationDoc,
  models,
  type,
} from "../index.js";
import { createMistralVibeAcpExecutor } from "./execute.js";
import { getQuotaWindows } from "./quota.js";
import { testEnvironment } from "./test.js";

const execute = createMistralVibeAcpExecutor();

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
      skillsMode: "unsupported",
      prerequisites: {},
    },
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
            key: "vibeAcpPath",
            label: "vibe-acp binary path",
            type: "text",
            hint: "Absolute path to the standalone vibe-acp binary. Falls back to PAPERCLIP_VIBE_ACP_PATH, then vibe-acp on PATH.",
            group: "Runtime",
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
