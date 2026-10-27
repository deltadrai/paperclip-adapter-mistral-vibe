import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as staticModels, DEFAULT_MISTRAL_VIBE_MODEL } from "../index.js";

const MISTRAL_MODELS_URL = "https://api.mistral.ai/v1/models";
const MODELS_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;

let cache: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

/** Test seam: drop the discovery cache between test cases. */
export function clearModelDiscoveryCacheForTests(): void {
  cache = null;
}

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

/**
 * Server-side key for model discovery. Per-agent keys live in each agent's
 * adapter env and are not visible here, so discovery uses the server process
 * environment: a plain MISTRAL_API_KEY (works on /v1/models with Code › Vibe
 * CLI keys) or the Enterprise MISTRAL_ADMIN_API_KEY already used for the quota
 * dashboard. Neither is required — without a key the static list is returned.
 */
function resolveDiscoveryKey(): string | null {
  const agentKey = process.env.MISTRAL_API_KEY?.trim();
  if (agentKey) return agentKey;
  const adminKey = process.env.MISTRAL_ADMIN_API_KEY?.trim();
  if (adminKey) return adminKey;
  return null;
}

function knownLabel(id: string): string | null {
  const known = staticModels.find((model) => model.id === id);
  return known ? known.label : null;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || knownLabel(id) || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([...models, ...staticModels]).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

async function fetchMistralModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(MISTRAL_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const discovered: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      discovered.push({ id, label: knownLabel(id) ?? id });
    }
    return dedupeModels(discovered);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadMistralVibeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const apiKey = resolveDiscoveryKey();
  if (!apiKey) return dedupeModels(staticModels);

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!options?.forceRefresh && cache && cache.keyFingerprint === keyFingerprint && cache.expiresAt > now) {
    return cache.models;
  }

  const discovered = await fetchMistralModels(apiKey);
  if (discovered.length === 0) {
    // No live data (offline, rejected key): keep any existing cache out of the
    // way and serve the static list.
    cache = null;
    return dedupeModels(staticModels);
  }

  const merged = mergedWithFallback(discovered);
  cache = { keyFingerprint, expiresAt: now + MODELS_CACHE_TTL_MS, models: merged };
  return merged;
}

/** Paperclip listModels(): live model discovery with a short cache. */
export async function listMistralVibeModels(): Promise<AdapterModel[]> {
  return loadMistralVibeModels();
}

/** Paperclip refreshModels(): bypass the cache (UI "refresh models" path). */
export async function refreshMistralVibeModels(): Promise<AdapterModel[]> {
  return loadMistralVibeModels({ forceRefresh: true });
}

/**
 * Paperclip detectModel(): read the currently configured model from the host
 * default Vibe home (per-agent homes are not visible here — this detects a
 * default-install setup). Returns the top-level active_model plus the
 * configured model aliases as candidates.
 */
export async function detectMistralVibeModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  const vibeHome = process.env.VIBE_HOME?.trim() || path.join(os.homedir(), ".vibe");
  const configPath = path.join(vibeHome, "config.toml");
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const activeMatch = content.match(/^active_model\s*=\s*"([^"]+)"/m);
  if (!activeMatch) return null;
  const candidates = [...content.matchAll(/^alias\s*=\s*"([^"]+)"/gm)]
    .map((match) => match[1])
    .filter((alias, index, all) => all.indexOf(alias) === index);
  return {
    model: activeMatch[1],
    provider: "mistral",
    source: configPath,
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

export { DEFAULT_MISTRAL_VIBE_MODEL };
