import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const modelsMod = await import("../dist/server/models.js");
const server = await import("../dist/server/index.js");

const savedEnv = {};

function setEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv() {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.after(() => restoreEnv());

function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("listModels without a server key returns the static list without fetching", async () => {
  setEnv("MISTRAL_API_KEY", undefined);
  setEnv("MISTRAL_ADMIN_API_KEY", undefined);
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([]);
  try {
    const models = await modelsMod.listMistralVibeModels();
    assert.ok(models.length > 0);
    assert.ok(models.some((m) => m.id === "mistral-medium-latest"));
    assert.equal(fetchStub.calls.length, 0, "no API key: must not call the API");
  } finally {
    fetchStub.restore();
  }
});

test("listModels with a key merges discovered models with the static list", async () => {
  setEnv("MISTRAL_API_KEY", "test-key-123456");
  setEnv("MISTRAL_ADMIN_API_KEY", undefined);
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([
    jsonResponse(200, {
      data: [{ id: "mistral-medium-latest" }, { id: "brand-new-model" }, { id: "brand-new-model" }],
    }),
  ]);
  try {
    const models = await modelsMod.listMistralVibeModels();
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("mistral-medium-latest"), "known model must keep its curated label");
    assert.ok(ids.includes("brand-new-model"), "discovered model must appear");
    assert.equal(ids.filter((id) => id === "brand-new-model").length, 1, "discovered models dedupe");
    assert.ok(ids.includes("mistral-large-latest"), "static fallback stays available");
    const medium = models.find((m) => m.id === "mistral-medium-latest");
    assert.ok(medium.label.includes("Mistral Medium"), "known ids keep curated labels");
    const fresh = models.find((m) => m.id === "brand-new-model");
    assert.equal(fresh.label, "brand-new-model", "unknown ids fall back to id as label");
    const sorted = [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
    assert.deepEqual(ids, sorted, "models are sorted");
    assert.equal(fetchStub.calls.length, 1);
    assert.ok(fetchStub.calls[0].url.includes("api.mistral.ai/v1/models"));
    assert.equal(fetchStub.calls[0].init.headers.Authorization, "Bearer test-key-123456");
  } finally {
    fetchStub.restore();
  }
});

test("listModels prefers MISTRAL_API_KEY over MISTRAL_ADMIN_API_KEY", async () => {
  setEnv("MISTRAL_API_KEY", "primary-key-1");
  setEnv("MISTRAL_ADMIN_API_KEY", "admin-key-1");
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([jsonResponse(200, { data: [{ id: "some-model" }] })]);
  try {
    await modelsMod.listMistralVibeModels();
    assert.equal(fetchStub.calls[0].init.headers.Authorization, "Bearer primary-key-1");
  } finally {
    fetchStub.restore();
  }
});

test("listModels falls back to the admin key when no agent key is set", async () => {
  setEnv("MISTRAL_API_KEY", undefined);
  setEnv("MISTRAL_ADMIN_API_KEY", "admin-key-2");
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([jsonResponse(200, { data: [{ id: "some-model" }] })]);
  try {
    const models = await modelsMod.listMistralVibeModels();
    assert.equal(fetchStub.calls[0].init.headers.Authorization, "Bearer admin-key-2");
    assert.ok(models.some((m) => m.id === "some-model"));
  } finally {
    fetchStub.restore();
  }
});

test("listModels caches within the TTL; refreshModels bypasses the cache", async () => {
  setEnv("MISTRAL_API_KEY", "cache-key-1");
  setEnv("MISTRAL_ADMIN_API_KEY", undefined);
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([
    jsonResponse(200, { data: [{ id: "model-a" }] }),
    jsonResponse(200, { data: [{ id: "model-b" }] }),
  ]);
  try {
    await modelsMod.listMistralVibeModels();
    await modelsMod.listMistralVibeModels();
    assert.equal(fetchStub.calls.length, 1, "second call within TTL must hit the cache");
    const refreshed = await modelsMod.refreshMistralVibeModels();
    assert.equal(fetchStub.calls.length, 2, "refresh must bypass the cache");
    assert.ok(refreshed.some((m) => m.id === "model-b"));
  } finally {
    fetchStub.restore();
  }
});

test("listModels returns the static list when the API fails", async () => {
  setEnv("MISTRAL_API_KEY", "failing-key-1");
  modelsMod.clearModelDiscoveryCacheForTests();
  const fetchStub = stubFetch([jsonResponse(500, { error: "boom" })]);
  try {
    const models = await modelsMod.listMistralVibeModels();
    assert.ok(models.some((m) => m.id === "mistral-medium-latest"));
    assert.ok(!models.some((m) => m.id === "model-a"));
  } finally {
    fetchStub.restore();
  }
});

test("detectModel reads active_model and aliases from $VIBE_HOME/config.toml", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-detect-"));
  const previous = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  try {
    assert.equal(await modelsMod.detectMistralVibeModel(), null, "missing config must return null");
    await fs.writeFile(
      path.join(home, "config.toml"),
      [
        'active_model = "mistral-medium-latest"',
        "",
        "[[models]]",
        'name = "mistral-medium-latest"',
        'provider = "mistral"',
        'alias = "mistral-medium-latest"',
        "",
        "[[models]]",
        'name = "custom-openai"',
        'provider = "openai"',
        'alias = "gpt-4o"',
        "",
      ].join("\n"),
      "utf8",
    );
    const detected = await modelsMod.detectMistralVibeModel();
    assert.ok(detected);
    assert.equal(detected.model, "mistral-medium-latest");
    assert.equal(detected.provider, "mistral");
    assert.ok(detected.source.includes("config.toml"));
    assert.deepEqual(detected.candidates, ["mistral-medium-latest", "gpt-4o"]);
  } finally {
    if (previous === undefined) delete process.env.VIBE_HOME;
    else process.env.VIBE_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("server adapter exposes the discovery hooks", () => {
  const adapter = server.createServerAdapter();
  assert.equal(typeof adapter.listModels, "function");
  assert.equal(typeof adapter.refreshModels, "function");
  assert.equal(typeof adapter.detectModel, "function");
  // static list stays the contract baseline
  assert.ok(Array.isArray(adapter.models) && adapter.models.length > 0);
});
