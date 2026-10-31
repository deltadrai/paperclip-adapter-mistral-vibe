import fs from "node:fs/promises";
import path from "node:path";
import { asString, parseObject, resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

export const VIBE_ACP_ENV_VAR = "PAPERCLIP_VIBE_ACP_PATH";
export const VIBE_CLI_ENV_VAR = "PAPERCLIP_VIBE_CLI_PATH";
export const MISTRAL_API_KEY_ENV_VAR = "MISTRAL_API_KEY";

export type MistralVibeExecutionEngine = "acp" | "cli";

/** Agent profiles `vibe -p` accepts for tool approval. */
export const CLI_AGENT_PROFILES = ["auto-approve", "smart-approve", "accept-edits", "default"] as const;
export type CliAgentProfile = (typeof CLI_AGENT_PROFILES)[number];

export function resolveExecutionEngine(config: Record<string, unknown>): MistralVibeExecutionEngine {
  const engine = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "";
  return engine === "cli" ? "cli" : "acp";
}

/** Tool-approval profile for the CLI lane; auto-approve mirrors the ACP lane's approve-all default. */
export function resolveCliAgent(config: Record<string, unknown>): CliAgentProfile {
  const configured = typeof config.cliAgent === "string" ? config.cliAgent.trim().toLowerCase() : "";
  return (CLI_AGENT_PROFILES as readonly string[]).includes(configured)
    ? (configured as CliAgentProfile)
    : "auto-approve";
}

export type VibeAcpCommandSource = "config" | "env" | "path";

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export async function pathIsExecutable(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate) && !hasPathSeparator(candidate)) return false;
  try {
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the vibe-acp command and where it came from. Order:
 * config.vibeAcpPath → env PAPERCLIP_VIBE_ACP_PATH → `vibe-acp` on PATH.
 */
export async function resolveVibeAcpCommand(
  config: Record<string, unknown>,
): Promise<{ command: string; source: VibeAcpCommandSource }> {
  const fromConfig = firstNonEmptyString(config.vibeAcpPath);
  if (fromConfig) return { command: fromConfig, source: "config" };
  const fromEnv = firstNonEmptyString(process.env[VIBE_ACP_ENV_VAR]);
  if (fromEnv) return { command: fromEnv, source: "env" };
  return { command: "vibe-acp", source: "path" };
}

/**
 * Resolve the vibe CLI command and where it came from. Order:
 * config.vibeCliPath → env PAPERCLIP_VIBE_CLI_PATH → `vibe` on PATH.
 */
export async function resolveVibeCliCommand(
  config: Record<string, unknown>,
): Promise<{ command: string; source: VibeAcpCommandSource }> {
  const fromConfig = firstNonEmptyString(config.vibeCliPath);
  if (fromConfig) return { command: fromConfig, source: "config" };
  const fromEnv = firstNonEmptyString(process.env[VIBE_CLI_ENV_VAR]);
  if (fromEnv) return { command: fromEnv, source: "env" };
  return { command: "vibe", source: "path" };
}

/**
 * Default per-agent VIBE_HOME: a stable directory under the Paperclip instance
 * root, keyed by company id and agent id, so agent state survives server
 * restarts and concurrent agents never share a directory.
 */
export function resolveDefaultVibeHome(companyId: string, agentId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter();
  return path.join(instanceRoot, "companies", companyId, "mistral-vibe", "agents", agentId, "home");
}

export function resolveVibeHome(
  config: Record<string, unknown>,
  companyId: string,
  agentId: string,
): string {
  const configured = firstNonEmptyString(config.vibeHome);
  return path.resolve(configured ?? resolveDefaultVibeHome(companyId, agentId));
}

export async function ensureVibeHomeDir(vibeHome: string): Promise<void> {
  await fs.mkdir(vibeHome, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(vibeHome, 0o700);
  } catch {
    // Best effort: some filesystems (e.g. mounted volumes) reject chmod.
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildManagedConfigToml(model: string): string {
  return [
    "# Managed by paperclip-adapter-mistral-vibe. The active_model value and the",
    "# mistral-vibe [[models]] alias below are applied by the Paperclip adapter.",
    "",
    `active_model = ${tomlString(model)}`,
    "",
    "[[models]]",
    `name = ${tomlString(model)}`,
    `provider = "mistral"`,
    `alias = ${tomlString(model)}`,
    "",
  ].join("\n");
}

function hasTopLevelKey(content: string, key: string): boolean {
  return new RegExp(`^${key}\\s*=`, "m").test(content);
}

/** Any top-level `models = ...` inline key line (before the first table header). */
const INLINE_MODELS_LINE = /^models[ \t]*=/;

/** An inline empty-array `models = []` key line, tolerant of spacing/comments. */
const EMPTY_INLINE_MODELS_LINE = /^models[ \t]*=[ \t]*\[[ \t]*\][ \t]*(?:#.*)?$/;

/**
 * Remove top-level `models = []` inline keys.
 *
 * Vibe persists an empty model map as an inline empty array (tomli_w), and
 * appending a `[[models]]` block after such a key is invalid TOML: tomllib
 * rejects it with "Cannot mutate immutable namespace ('models',)". Dropping
 * the key is semantically neutral (absence == empty list) and repairs configs
 * already corrupted by earlier appends.
 *
 * Returns the (possibly unchanged) content and whether a top-level inline
 * `models` key remains — a non-empty inline array can never be followed by
 * `[[models]]`, so callers must not append after it.
 */
function stripEmptyInlineModels(content: string): { content: string; hasInlineModels: boolean } {
  const headerIndex = content.search(/^\[/m);
  const topLevelEnd = headerIndex === -1 ? content.length : headerIndex;
  const lines = content.slice(0, topLevelEnd).split("\n");
  let hasInlineModels = false;
  let stripped = false;
  const kept = lines.filter((line) => {
    if (!INLINE_MODELS_LINE.test(line)) return true;
    if (!EMPTY_INLINE_MODELS_LINE.test(line)) {
      hasInlineModels = true;
      return true;
    }
    stripped = true;
    return false;
  });
  if (!stripped) return { content, hasInlineModels };
  return { content: kept.join("\n") + content.slice(topLevelEnd), hasInlineModels };
}

function hasModelAlias(content: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^alias\\s*=\\s*"${escaped}"\\s*$`, "m").test(content);
}

/**
 * Ensure `$VIBE_HOME/config.toml` selects `model` as the active model and that
 * a matching `[[models]]` entry exists, so vibe-acp's `set_config_option`
 * ("model") validation accepts the value the ACP engine sends.
 *
 * The merge is deliberately minimal TOML surgery (no TOML parser dependency):
 * - fresh file → write the managed template
 * - existing file → replace the top-level `active_model` value in place, or
 *   prepend it at the very top (a bare key after a table header would attach
 *   to that table, and duplicate keys are a TOML error)
 * - append a `[[models]]` block only when no entry already declares the alias,
 *   and only after dropping a top-level `models = []` inline key — vibe
 *   persists an empty model map that way, and `[[models]]` after an inline
 *   array is invalid TOML ("Cannot mutate immutable namespace"); dropping the
 *   key also repairs configs already corrupted by earlier appends
 * - a non-empty inline `models = [...]` key is left untouched and blocks the
 *   append (it cannot be merged safely without a TOML parser)
 *
 * Writes happen only when the content actually changes, so the file's mtime
 * stays stable across runs with the same model.
 */
export async function ensureVibeConfigModel(vibeHome: string, model: string): Promise<void> {
  const configPath = path.join(vibeHome, "config.toml");
  let current = "";
  try {
    current = await fs.readFile(configPath, "utf8");
  } catch {
    current = "";
  }

  let next: string;
  if (current.trim().length === 0) {
    next = buildManagedConfigToml(model);
  } else {
    next = current;
    if (hasTopLevelKey(next, "active_model")) {
      next = next.replace(/^(active_model\s*=\s*).*$/m, `$1${tomlString(model)}`);
    } else {
      next = `active_model = ${tomlString(model)}\n${next.replace(/^\n+/, "")}`;
    }
    const stripped = stripEmptyInlineModels(next);
    next = stripped.content;
    // A non-empty inline `models = [...]` cannot be merged without a TOML
    // parser and cannot be followed by `[[models]]`: leave it untouched and
    // skip the append so the file stays parseable.
    if (!stripped.hasInlineModels && !hasModelAlias(next, model)) {
      if (!next.endsWith("\n")) next += "\n";
      next += `\n[[models]]\nname = ${tomlString(model)}\nprovider = "mistral"\nalias = ${tomlString(model)}\n`;
    }
  }

  if (next === current) return;
  await fs.writeFile(configPath, next, { encoding: "utf8", mode: 0o600 });
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

/**
 * Seed the run's working directory into the per-agent trust store
 * (`$VIBE_HOME/trusted_folders.toml`). ACP clients cannot answer Vibe's
 * workspace-trust prompt at runtime, so the adapter grants trust up front for
 * the directory the agent will work in. The file is per-agent, so this never
 * affects other agents or the host.
 */
export async function ensureVibeTrustedFolder(vibeHome: string, cwd: string): Promise<void> {
  const trustPath = path.join(vibeHome, "trusted_folders.toml");
  const resolvedCwd = path.resolve(cwd);
  let trusted: string[] = [];
  let untrusted: string[] = [];
  try {
    const raw = await fs.readFile(trustPath, "utf8");
    const trustedMatch = raw.match(/^trusted\s*=\s*\[(.*?)\]/ms);
    const untrustedMatch = raw.match(/^untrusted\s*=\s*\[(.*?)\]/ms);
    const parseList = (rawList: string | undefined): string[] =>
      rawList
        ? rawList.split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean)
        : [];
    trusted = parseList(trustedMatch?.[1]);
    untrusted = parseList(untrustedMatch?.[1]);
  } catch {
    trusted = [];
    untrusted = [];
  }
  untrusted = untrusted.filter((entry) => entry !== resolvedCwd);
  if (trusted.includes(resolvedCwd)) return;
  trusted.push(resolvedCwd);
  const content = `trusted = ${tomlStringArray(trusted)}\nuntrusted = ${tomlStringArray(untrusted)}\n`;
  await fs.writeFile(trustPath, content, { encoding: "utf8", mode: 0o600 });
}

/** True when the adapter config carries a non-empty MISTRAL_API_KEY env value. */
export function configHasMistralApiKey(config: Record<string, unknown>): boolean {
  const env = parseObject(config.env);
  const value = env[MISTRAL_API_KEY_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0;
}

export function readConfigString(config: Record<string, unknown>, key: string): string {
  return asString(config[key], "");
}
