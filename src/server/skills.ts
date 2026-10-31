import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { ensureVibeHomeDir, resolveVibeHome } from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const SKILLS_LOCATION_LABEL = "the agent's own VIBE_HOME/skills directory";

/**
 * Where Paperclip-managed skills land for this agent: `<vibeHome>/skills`.
 * Both execution engines (vibe-acp ACP and vibe CLI) run with the same
 * per-agent VIBE_HOME, and Mistral Vibe discovers skills from
 * `$VIBE_HOME/skills/<name>/SKILL.md`, so one mount point serves both lanes.
 */
export function resolveMistralVibeSkillsHome(
  config: Record<string, unknown>,
  companyId: string,
  agentId: string,
): string {
  return path.join(resolveVibeHome(config, companyId, agentId), "skills");
}

interface MistralVibeSkillSyncInput {
  config: Record<string, unknown>;
  companyId: string;
  agentId: string;
}

/** Desired skill keys for this agent, including the operational paperclip skill. */
async function resolveDesiredSkills(
  config: Record<string, unknown>,
): Promise<{ availableEntries: Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>; desiredKeys: string[] }> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredKeys = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return { availableEntries, desiredKeys };
}

async function buildMistralVibeSkillSnapshot(
  input: MistralVibeSkillSyncInput,
  availableEntries: Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>,
  desiredKeys: string[],
): Promise<AdapterSkillSnapshot> {
  const { config, companyId, agentId } = input;
  const skillsHome = resolveMistralVibeSkillsHome(config, companyId, agentId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "mistral_vibe",
    availableEntries,
    desiredSkills: desiredKeys,
    installed,
    skillsHome,
    locationLabel: SKILLS_LOCATION_LABEL,
    installedDetail: "Installed in the agent's own VIBE_HOME/skills directory.",
    missingDetail:
      "Configured but not currently linked into the agent's VIBE_HOME/skills directory.",
    externalConflictDetail:
      "Skill name is occupied by an entry Paperclip did not install in the agent's skills directory.",
    externalDetail: "Installed outside Paperclip management in the agent's skills directory.",
  });
}

/** Report the current skill state of this agent's VIBE skills directory. */
export async function listMistralVibeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const { availableEntries, desiredKeys } = await resolveDesiredSkills(ctx.config);
  return buildMistralVibeSkillSnapshot(ctx, availableEntries, desiredKeys);
}

/**
 * Apply a desired skill set to the agent's VIBE skills directory: link every
 * desired available skill, drop stale Paperclip-managed links, and never
 * touch user-installed entries. Returns the resulting snapshot.
 */
export async function syncMistralVibeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const { config } = ctx;
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  // Operational/feedback skills stay mounted regardless of the assignment the
  // server is applying; the agent needs the paperclip skill to report progress.
  const legacyKeys = resolveLegacyPaperclipDesiredSkillNames({}, availableEntries);
  const desiredSet = new Set([...legacyKeys, ...desiredSkills]);
  const skillsHome = resolveMistralVibeSkillsHome(config, ctx.companyId, ctx.agentId);
  await ensureVibeHomeDir(path.dirname(skillsHome));
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key) || isPaperclipSkillSourceMissing(available)) continue;
    await ensurePaperclipSkillSymlink(available.source, path.join(skillsHome, available.runtimeName));
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildMistralVibeSkillSnapshot(ctx, availableEntries, Array.from(desiredSet));
}

/**
 * Executor-time self-healing for both engines: (re-)link the desired skills
 * into the agent's VIBE skills directory before a run. Repairs links deleted
 * on disk and applies skill version updates whose materialized source moved.
 * Never throws: a skill sync failure must not fail the run; problems are
 * reported to onLog when provided.
 */
export async function ensureMistralVibeSkillsLinked(
  config: Record<string, unknown>,
  companyId: string,
  agentId: string,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void,
): Promise<void> {
  let availableEntries;
  let desiredKeys: string[];
  try {
    ({ availableEntries, desiredKeys } = await resolveDesiredSkills(config));
  } catch {
    return;
  }
  if (desiredKeys.length === 0) return;
  const desiredSet = new Set(desiredKeys);
  const skillsHome = resolveMistralVibeSkillsHome(config, companyId, agentId);
  try {
    await ensureVibeHomeDir(path.dirname(skillsHome));
    await fs.mkdir(skillsHome, { recursive: true });
  } catch {
    return;
  }
  for (const available of availableEntries) {
    if (!desiredSet.has(available.key) || isPaperclipSkillSourceMissing(available)) continue;
    try {
      const result = await ensurePaperclipSkillSymlink(
        available.source,
        path.join(skillsHome, available.runtimeName),
      );
      if (result === "repaired" && onLog) {
        await onLog(
          "stdout",
          `[paperclip] Repaired Vibe skill "${available.key}" in ${skillsHome}\n`,
        );
      }
    } catch (err) {
      if (onLog) {
        await onLog(
          "stdout",
          `[paperclip] Failed to link Vibe skill "${available.key}": ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }
}
