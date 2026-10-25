# paperclip-adapter-mistral-vibe

External adapter plugin that runs [Mistral Vibe](https://github.com/mistralai/mistral-vibe) agents in [Paperclip](https://paperclip.ing) over ACP (`vibe-acp`).

- Adapter type key: `mistral_vibe` (label: **Mistral Vibe**)
- License: MIT
- Runs each agent with its **own Vibe state** (`VIBE_HOME`) and its **own Mistral API key**, so several Vibe agents can run concurrently.
- Thin by design: `execute` delegates to Paperclip's shared ACP engine (`@paperclipai/adapter-utils/acpx-engine`) with `agent: "custom"` and `agentCommand: <vibe-acp path>`.

## How it works

```
Paperclip UI ──"Add agent: Mistral Vibe, model X"──▶ paperclip-server
                                                          │
                          adapter plugin mistral_vibe (npm, installed into the Paperclip home)
                                                          │  createAcpxEngineExecutor(...)
                                                          │  agent=custom, agentCommand=<vibe-acp path>
                                                          ▼
                                           spawn vibe-acp   (stdio ACP)
                                             env: VIBE_HOME=<per-agent dir under the Paperclip instance root>
                                                  MISTRAL_API_KEY=<this agent's key, from its adapter env>
                                                  PAPERCLIP_* (injected by Paperclip)
                                                          │ HTTPS
                                                          ▼
                                              Mistral API, Vibe team plan
```

Isolation guarantees:

- **Per-agent state.** Every agent gets its own `VIBE_HOME` (default: `<paperclip instance root>/companies/<companyId>/mistral-vibe/agents/<agentId>/home`). Config, `.env`, session logs, caches and history never collide, so concurrent agents never corrupt each other (the failure mode that sank upstream PR #8378).
- **Per-agent credential.** The agent's `MISTRAL_API_KEY` is passed only to that agent's `vibe-acp` process through the run environment. Do **not** put the key in the container-wide environment (`/etc/secrets/paperclip.env`) — every Claude/Codex/OpenCode process would inherit it.
- **Workspace trust.** ACP clients cannot answer Vibe's interactive workspace-trust prompt, so the adapter seeds the run's working directory into the agent's own `trusted_folders.toml` before launch.
- **Model plumbing.** The adapter writes the selected model into the agent's `VIBE_HOME/config.toml` (`active_model` + a `[[models]]` alias entry) so `vibe-acp` accepts the model the ACP engine selects via `session/set_config_option`.

## Prerequisites

1. **The standalone `vibe-acp` binary.** Download `vibe-acp-<platform>-<version>.tar.gz` from the [mistral-vibe releases](https://github.com/mistralai/mistral-vibe/releases) (e.g. `vibe-acp-linux-aarch64-3.0.2.tar.gz`, ~72 MB). It is self-contained (bundles its own Python), so it needs nothing from the host. Extract it somewhere stable, e.g.:

   ```sh
   mkdir -p /opt/vibe-acp
   tar -xzf vibe-acp-linux-aarch64-3.0.2.tar.gz -C /opt/vibe-acp
   /opt/vibe-acp/vibe-acp --version   # → vibe-acp 3.0.2
   ```

2. **A Mistral API key** created under **Code › Vibe CLI** in the [Mistral console](https://console.mistral.ai). Usage draws from the plan's included quota first; pay-as-you-go is off by default.

3. **Node >= 24.11** for the Paperclip server (required by the shared ACP engine in `@paperclipai/adapter-utils`). The environment test checks this.

## Install the adapter

In Paperclip: **Settings → Adapters → Install from npm**, enter `paperclip-adapter-mistral-vibe`.

Or via the API: `POST /api/adapters` with `{ "packageName": "paperclip-adapter-mistral-vibe" }`.

## Point Paperclip at the binary

Resolution order for the `vibe-acp` command:

1. `vibeAcpPath` in the agent's adapter config (per agent)
2. `PAPERCLIP_VIBE_ACP_PATH` in the server environment (host-wide)
3. `vibe-acp` on `PATH`

## Add an agent

**Add agent → Mistral Vibe**, then configure:

| Field | Value |
|---|---|
| Model | e.g. `mistral-medium-latest` (default), `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, `zai-glm-5-3`, … |
| env | `MISTRAL_API_KEY=<your key>` — a Paperclip **secret reference** is supported and recommended |
| vibeAcpPath | `/opt/vibe-acp/vibe-acp` (optional if the binary is on `PATH` or `PAPERCLIP_VIBE_ACP_PATH` is set) |

Run **Test environment** on the agent. The test checks:

- Node >= 24.11 (ACP engine requirement)
- `vibe-acp` resolvable and `--version` reported
- `VIBE_HOME` resolvable and writable
- `MISTRAL_API_KEY` present (in the agent env or `$VIBE_HOME/.env`) — presence only, the value is never printed
- Optional live auth probe: `GET https://api.mistral.ai/v1/models` with the agent's key (disable with `vibeAuthProbe: false`)

## Quota dashboard (optional)

Runs draw from the **Vibe plan's included monthly usage** (shared across Studio, the API, and Vibe Code for the plan); pay-as-you-go applies only if the org enables it. Paperclip's per-run token tracking always works.

To surface the **remaining Vibe budget** in Paperclip's quota dashboard, set `MISTRAL_ADMIN_API_KEY` on the **Paperclip server process** (not per agent) to a Mistral **Admin API key** created in the Admin Panel. The adapter's `getQuotaWindows()` then queries:

- `GET https://api.mistral.ai/v1/admin/usage?month=<m>&year=<y>` — org consumption by category, including the dedicated `vibe_usage` category
- `GET https://api.mistral.ai/v1/admin/spend-limit` — the org monthly spending limit

and reports a **"Vibe monthly spend"** window: percent of the org monthly limit consumed, resetting at the end of the billing period. Without the server-side key, the quota row is simply absent.

Caveats:

- The Admin API is **Enterprise-only**; a standard Code › Vibe CLI plan key does **not** work on admin endpoints.
- The admin key is read from the server process environment only — it is never logged and never passed to agent runs.
- Whether a **Team** plan's Vibe budget is per-seat or org-shared is unverified (Mistral docs don't say); confirm before relying on the percentage.

## Configuration reference

See `agentConfigurationDoc` in the adapter (rendered in the Paperclip UI) for the full list. Highlights:

- `model` (string): Mistral API model id. Default `mistral-medium-latest`.
- `env` (object): `KEY=VALUE` variables for the agent process. `MISTRAL_API_KEY` belongs here. `VIBE_HOME` is always set per agent by the adapter and overrides any value here.
- `vibeAcpPath` (string): absolute path to the `vibe-acp` binary.
- `vibeHome` (string): absolute `VIBE_HOME` override for this agent.
- `vibeAuthProbe` (boolean, default `true`): live auth probe in the environment test.
- `cwd`, `instructionsFilePath`, `promptTemplate`, `timeoutSec`, `graceSec`, `mode`, `permissionMode`, `nonInteractivePermissions`, `warmHandleIdleMs`.

Notes:

- `effort` / `thinkingEffort` / `fastMode` are **not** forwarded: `vibe-acp` rejects them as unsupported config options.
- Sessions resume across heartbeats via the shared ACP engine's session codec. Changing the agent's env (including the key) starts a fresh session.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # node --test smoke tests against dist/
```

The `./ui-parser` export (`dist/ui-parser.js`) is self-contained (zero runtime imports) and served to the browser for run-transcript rendering. Its engine-line mapping is adapted from `parseAcpxStdoutLine` in `@paperclipai/adapter-utils` (Paperclip is MIT-licensed).

## License

MIT — see [LICENSE](./LICENSE).
