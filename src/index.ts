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

Adapter: mistral_vibe (Mistral Vibe via vibe-acp ACP or the vibe CLI)

Use when:
- You want Paperclip to run agents on Mistral Vibe (Code › Vibe CLI plan keys)
- You want each agent to keep its own Vibe state and its own Mistral API key
- Multiple Vibe agents should run concurrently without sharing ~/.vibe

Don't use when:
- You want a plain Mistral API adapter (non-Vibe)
- You run agents on a remote sandbox or another host

Execution engines (engine):
- acp (default): runs the standalone vibe-acp binary through Paperclip's shared
  ACP engine. Supports interactive permission prompting surfaced in the
  Paperclip UI. Requires Node >= 24.11 on the Paperclip server.
- cli: runs the vibe CLI headless (vibe -p) — one process per run. Sessions
  resume across runs via --resume (the id is stored in the agent's VIBE_HOME
  and survives server restarts; a failed resume falls back to a fresh session).
  Per-run usage and cost come from vibe's export.json. The CLI lane cannot ask
  for approval mid-run: unanswered approval callbacks are auto-denied and
  surfaced in the transcript, so pick the cliAgent profile up front. Install
  via "uv tool install mistral-vibe" (installs vibe and vibe-acp side by
  side) or download from https://github.com/mistralai/mistral-vibe/releases.

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

Skills (both engines):
- Skills assigned to this agent in the Paperclip UI sync into the agent's own
  $VIBE_HOME/skills/ directory (symlinks to the materialized skill files).
  Mistral Vibe discovers skills from there, and both engines share the same
  per-agent VIBE_HOME, so the acp and cli lanes see the same skills.
- The operational paperclip skill is mounted automatically so the agent can
  report progress through the Paperclip API.
- Each run re-asserts the desired links (repairs deleted or dangling links,
  picks up version updates); sync problems are logged and never block a run.
- User-installed skills in $VIBE_HOME/skills/ are left untouched and show up
  as external entries in the UI.

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
  The model picker merges live discovery (GET /v1/models via the server-side
  MISTRAL_API_KEY or MISTRAL_ADMIN_API_KEY) with the adapter's static list;
  without a server-side key the static list is served. refreshModels bypasses
  the discovery cache; detectModel reads active_model from the host default
  $VIBE_HOME/config.toml.
- The selected model is written into the agent's VIBE_HOME/config.toml
  (active_model + [[models]] alias) so both engines run on it: vibe-acp
  accepts the model the ACP engine selects via session/set_config_option,
  and the CLI lane runs on the config.toml active model.
- env (object, optional): KEY=VALUE environment variables for the agent process.
  Set MISTRAL_API_KEY here (a Paperclip secret reference is supported).
  VIBE_HOME is always set per agent by the adapter and overrides any value here.
- cwd (string, optional): default absolute working directory fallback.
- instructionsFilePath (string, optional): absolute path to a markdown instructions
  file delivered to the agent (AGENTS.md bundle).
- promptTemplate (string, optional): run prompt template.

Runtime fields:
- engine (string, optional): acp (default) | cli. Selects the execution engine;
  the config form shows only the fields for the selected engine.
- vibeAcpPath (string, optional, acp): absolute path to the vibe-acp binary.
- vibeCliPath (string, optional, cli): absolute path to the vibe binary.
  Resolution: vibeCliPath → PAPERCLIP_VIBE_CLI_PATH → vibe on PATH.
- cliAgent (string, optional, cli, default auto-approve): tool-approval profile
  for vibe -p — auto-approve | smart-approve | accept-edits | default.
- cliFreshSession (boolean, optional, cli, default false): skip the stored
  resume id and start a new vibe session.
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
