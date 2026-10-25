export const type = "mistral_vibe";
export const label = "Mistral Vibe";

export const DEFAULT_MISTRAL_VIBE_MODEL = "mistral-medium-latest";

export const models = [
  { id: DEFAULT_MISTRAL_VIBE_MODEL, label: "Mistral Medium 3.5 (mistral-medium-latest)" },
  { id: "mistral-large-latest", label: "Mistral Large 3 (mistral-large-latest)" },
  { id: "mistral-small-latest", label: "Mistral Small 4 (mistral-small-latest)" },
  { id: "codestral-latest", label: "Codestral (codestral-latest)" },
  { id: "zai-glm-5-3", label: "Z.ai GLM 5.3 (zai-glm-5-3)" },
  { id: "zai-glm-5-2", label: "Z.ai GLM 5.2 (zai-glm-5-2)" },
  { id: "ministral-14b-latest", label: "Ministral 3 14B (ministral-14b-latest)" },
  { id: "ministral-8b-latest", label: "Ministral 3 8B (ministral-8b-latest)" },
  { id: "ministral-3b-latest", label: "Ministral 3 3B (ministral-3b-latest)" },
];

export const agentConfigurationDoc = `# mistral_vibe agent configuration

Adapter: mistral_vibe (Mistral Vibe via the vibe-acp ACP server)

Use when:
- You want Paperclip to run agents on Mistral Vibe (Code › Vibe CLI plan keys)
- You want each agent to keep its own Vibe state and its own Mistral API key
- Multiple Vibe agents should run concurrently without sharing ~/.vibe

Don't use when:
- You want Vibe's terminal UI or the headless \`vibe -p\` path (only the ACP path is supported)
- You want a plain Mistral API adapter (non-Vibe)
- You run agents on a remote sandbox or another host

Isolation model (important):
- Every agent runs with its own VIBE_HOME (default: a stable per-agent directory
  under the Paperclip instance root, keyed by company id and agent id), so
  config, .env, session logs, caches and history never collide between agents.
- The agent's MISTRAL_API_KEY is passed only to that agent's vibe-acp process via
  the run environment. Never put the key in the container-wide environment
  (/etc/secrets/paperclip.env): every other agent process would inherit it.
- The adapter seeds the run's working directory into the agent's own
  trusted_folders.toml, because ACP clients cannot answer Vibe's interactive
  workspace-trust prompt.

Prerequisites:
- The standalone vibe-acp binary (self-contained; ships its own Python).
  Download vibe-acp-<platform>-<version>.tar.gz from
  https://github.com/mistralai/mistral-vibe/releases and point the adapter at it
  with vibeAcpPath (agent config) or PAPERCLIP_VIBE_ACP_PATH (server environment).
  Resolution order: vibeAcpPath → PAPERCLIP_VIBE_ACP_PATH → \`vibe-acp\` on PATH.
- A Mistral API key created under Code › Vibe CLI in the Mistral console
  (https://console.mistral.ai). Usage draws from the plan's included quota first.

Core fields:
- model (string, optional): Mistral API model id. Defaults to mistral-medium-latest.
  The adapter writes it into the agent's VIBE_HOME/config.toml so vibe-acp accepts
  the model the ACP engine selects.
- env (object, optional): KEY=VALUE environment variables for the agent process.
  Set MISTRAL_API_KEY here (a Paperclip secret reference is supported).
  VIBE_HOME is always set per agent by the adapter and overrides any value here.
- cwd (string, optional): default absolute working directory fallback.
- instructionsFilePath (string, optional): absolute path to a markdown instructions
  file delivered to the agent (AGENTS.md bundle).
- promptTemplate (string, optional): run prompt template.

Runtime fields:
- vibeAcpPath (string, optional): absolute path to the vibe-acp binary.
- vibeHome (string, optional): absolute VIBE_HOME override for this agent.
- vibeAuthProbe (boolean, optional, default true): when true, the environment test
  performs a live GET https://api.mistral.ai/v1/models with the agent's key.
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout).
- graceSec (number, optional): SIGTERM grace period in seconds.
- mode (string, optional): persistent (default) | oneshot.
- permissionMode (string, optional): approve-all (default) | manual.
- nonInteractivePermissions (string, optional): deny (default) | approve-all.
- warmHandleIdleMs (number, optional): how long an idle agent process stays warm
  between runs (default 0 = shut down after each run).

Quota dashboard (optional, Enterprise-only):
- Paperclip polls each adapter's getQuotaWindows() for the quota dashboard. This
  adapter reports the org's Vibe usage when the Paperclip SERVER process has
  MISTRAL_ADMIN_API_KEY set (a Mistral Admin API key, created in the Admin
  Panel; Enterprise plans only — a Code › Vibe CLI plan key does not work on
  admin endpoints). The adapter queries GET /v1/admin/usage (vibe_usage
  category) and GET /v1/admin/spend-limit (monthly spending limit) and reports
  a "Vibe monthly spend" window (percent of the org limit consumed, reset at
  the end of the billing period). Without the server-side key the quota row is
  simply absent. The admin key is never passed to agent runs.
- Per-run token usage is always tracked from the ACP stream regardless.

Notes:
- effort / thinkingEffort / fastMode are not forwarded: vibe-acp rejects them as
  unsupported config options.
- Sessions resume across heartbeats via the shared ACP engine's session codec;
  changing the agent's env (including the key) starts a fresh session.
`;

export { createServerAdapter } from "./server/index.js";
export { parseStdoutLine } from "./ui-parser.js";
