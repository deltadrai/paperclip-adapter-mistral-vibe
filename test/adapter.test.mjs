import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const pkg = await import("../dist/index.js");
const server = await import("../dist/server/index.js");
const config = await import("../dist/server/config.js");
const executeMod = await import("../dist/server/execute.js");
const testMod = await import("../dist/server/test.js");
const uiParser = await import("../dist/ui-parser.js");

test("package metadata", () => {
  assert.equal(pkg.type, "mistral_vibe");
  assert.equal(pkg.label, "Mistral Vibe");
  assert.ok(Array.isArray(pkg.models) && pkg.models.length > 0);
  assert.equal(pkg.DEFAULT_MISTRAL_VIBE_MODEL, "mistral-medium-latest");
  assert.ok(pkg.models.some((m) => m.id === pkg.DEFAULT_MISTRAL_VIBE_MODEL));
  assert.equal(typeof pkg.agentConfigurationDoc, "string");
  assert.ok(pkg.agentConfigurationDoc.includes("mistral_vibe"));
});

test("createServerAdapter shape matches the plugin contract", () => {
  const adapter = server.createServerAdapter();
  assert.equal(adapter.type, "mistral_vibe");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.testEnvironment, "function");
  assert.equal(adapter.acp.agentId, "custom");
  assert.equal(adapter.acp.skillsMode, "ephemeral");
  assert.equal(adapter.runtimeToolDelivery, "environment");
  assert.equal(adapter.supportsInstructionsBundle, true);
  assert.equal(adapter.instructionsPathKey, "instructionsFilePath");
  assert.equal(adapter.supportsLocalAgentJwt, true);
  assert.equal(typeof adapter.sessionCodec.deserialize, "function");
  assert.equal(typeof adapter.sessionCodec.serialize, "function");
  assert.equal(typeof adapter.getConfigSchema, "function");
  assert.equal(adapter.loginCapability, undefined);
  assert.equal(adapter.getRuntimeCommandSpec, undefined);
  const schema = adapter.getConfigSchema();
  const keys = schema.fields.map((f) => f.key);
  for (const expected of ["model", "vibeAcpPath", "vibeHome", "vibeAuthProbe", "env"]) {
    assert.ok(keys.includes(expected), `schema missing ${expected}`);
  }
});

test("sessionCodec round-trips engine session params", () => {
  const codec = server.createServerAdapter().sessionCodec;
  const params = {
    sessionKey: "paperclip:co:ag:task:fp",
    acpSessionId: "acp-123",
    agentSessionId: "agent-456",
    runtimeSessionName: "run-7",
    agent: "custom",
    cwd: "/tmp/work",
    mode: "persistent",
  };
  const serialized = codec.serialize(params);
  assert.ok(serialized);
  const deserialized = codec.deserialize(serialized);
  assert.ok(deserialized);
  assert.equal(deserialized.acpSessionId, "acp-123");
  assert.equal(codec.getDisplayId?.(params), "run-7");
});

test("buildMistralVibeAcpConfig pins custom agent, forces VIBE_HOME, strips effort keys", () => {
  const next = executeMod.buildMistralVibeAcpConfig({
    config: {
      model: "mistral-large-latest",
      effort: "high",
      thinkingEffort: "high",
      reasoningEffort: "max",
      modelReasoningEffort: "max",
      fastMode: true,
      vibeAcpPath: "/opt/vibe-acp/vibe-acp",
      vibeHome: "/tmp/should-be-dropped",
      vibeAuthProbe: false,
      env: { MISTRAL_API_KEY: "sk-test", CUSTOM: "1" },
      cwd: "/tmp/work",
    },
    companyId: "co1",
    agentId: "ag1",
    vibeAcpCommand: "/opt/vibe-acp/vibe-acp",
    vibeHome: "/paperclip/instances/default/companies/co1/mistral-vibe/agents/ag1/home",
    cwd: "/tmp/work",
  });
  assert.equal(next.agent, "custom");
  assert.equal(next.agentCommand, "/opt/vibe-acp/vibe-acp");
  assert.equal(next.env.VIBE_HOME, "/paperclip/instances/default/companies/co1/mistral-vibe/agents/ag1/home");
  assert.equal(next.env.MISTRAL_API_KEY, "sk-test");
  assert.equal(next.env.CUSTOM, "1");
  assert.equal(next.model, "mistral-large-latest");
  for (const key of ["effort", "thinkingEffort", "reasoningEffort", "modelReasoningEffort", "fastMode", "vibeAcpPath", "vibeHome", "vibeAuthProbe"]) {
    assert.ok(!(key in next), `expected ${key} to be removed`);
  }
  assert.equal(next.mode, "persistent");
  assert.equal(next.permissionMode, "approve-all");
  assert.equal(next.nonInteractivePermissions, "deny");
  assert.equal(next.coalescePlaceholderToolUpdates, true);
});

test("buildMistralVibeAcpConfig drops default model so the engine keeps the vibe default", () => {
  const next = executeMod.buildMistralVibeAcpConfig({
    config: { model: "mistral-medium-latest" },
    companyId: "co1",
    agentId: "ag1",
    vibeAcpCommand: "vibe-acp",
    vibeHome: "/tmp/vh",
    cwd: "/tmp",
  });
  assert.ok(!("model" in next));
});

test("resolveVibeHome defaults to a stable per-agent dir and honors overrides", () => {
  const home = config.resolveVibeHome({}, "company-1", "agent-9");
  assert.ok(home.includes(path.join("companies", "company-1", "mistral-vibe", "agents", "agent-9", "home")));
  const overridden = config.resolveVibeHome({ vibeHome: "/data/vibe" }, "company-1", "agent-9");
  assert.equal(overridden, "/data/vibe");
});

test("resolveVibeAcpCommand order: config → env → PATH", async () => {
  const fromConfig = await config.resolveVibeAcpCommand({ vibeAcpPath: "/opt/vibe/vibe-acp" });
  assert.deepEqual(fromConfig, { command: "/opt/vibe/vibe-acp", source: "config" });

  const saved = process.env[config.VIBE_ACP_ENV_VAR];
  process.env[config.VIBE_ACP_ENV_VAR] = "/usr/local/bin/vibe-acp";
  try {
    const fromEnv = await config.resolveVibeAcpCommand({});
    assert.deepEqual(fromEnv, { command: "/usr/local/bin/vibe-acp", source: "env" });
  } finally {
    if (saved === undefined) delete process.env[config.VIBE_ACP_ENV_VAR];
    else process.env[config.VIBE_ACP_ENV_VAR] = saved;
  }

  const fromPath = await config.resolveVibeAcpCommand({});
  assert.deepEqual(fromPath, { command: "vibe-acp", source: "path" });
});

test("ensureVibeConfigModel writes a fresh managed config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  await config.ensureVibeConfigModel(home, "mistral-large-latest");
  const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(raw, /^active_model = "mistral-large-latest"$/m);
  assert.match(raw, /^\[\[models\]\]$/m);
  assert.match(raw, /^alias = "mistral-large-latest"$/m);
  assert.match(raw, /^provider = "mistral"$/m);
});

test("ensureVibeConfigModel replaces active_model and preserves unrelated content", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  const original = [
    'active_model = "mistral-small-latest"',
    "",
    "[some_table]",
    'key = "value"',
    "",
  ].join("\n");
  await fs.writeFile(path.join(home, "config.toml"), original);
  await config.ensureVibeConfigModel(home, "codestral-latest");
  const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(raw, /^active_model = "codestral-latest"$/m);
  assert.ok(!raw.includes('active_model = "mistral-small-latest"'));
  assert.ok(raw.includes('[some_table]'));
  assert.ok(raw.includes('key = "value"'));
  assert.match(raw, /^\[\[models\]\]$/m);
  assert.match(raw, /^alias = "codestral-latest"$/m);
});

test("ensureVibeConfigModel prepends active_model when missing and is idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  await fs.writeFile(path.join(home, "config.toml"), '[some_table]\nkey = "value"\n');
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const first = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(first.startsWith('active_model = "mistral-medium-latest"'));
  assert.ok(first.includes('[some_table]'));
  const mtime1 = (await fs.stat(path.join(home, "config.toml"))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const second = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.equal(second, first);
  const mtime2 = (await fs.stat(path.join(home, "config.toml"))).mtimeMs;
  assert.equal(mtime2, mtime1, "idempotent call must not rewrite the file");
  const aliasCount = (second.match(/^alias = "mistral-medium-latest"$/gm) || []).length;
  assert.equal(aliasCount, 1);
});

test("ensureVibeConfigModel drops an inline `models = []` key before appending [[models]]", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  // Shape vibe itself persists via tomli_w when its internal models map is
  // empty: top-level scalars plus an inline empty `models` array.
  const original = [
    'active_model = "mistral-medium-latest"',
    "api_timeout = 720.0",
    "enable_telemetry = true",
    "models = []",
    "",
  ].join("\n");
  await fs.writeFile(path.join(home, "config.toml"), original);
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(!/^models\s*=/m.test(raw), "inline models key must be removed");
  assert.match(raw, /^\[\[models\]\]$/m);
  assert.match(raw, /^alias = "mistral-medium-latest"$/m);
});

test("ensureVibeConfigModel repairs a config corrupted by an earlier append after `models = []`", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  // Exactly the state that bricked sessions: vibe wrote `models = []`, a
  // previous adapter run appended `[[models]]` after it (invalid TOML).
  const corrupt = [
    'active_model = "mistral-medium-latest"',
    "api_timeout = 720.0",
    "enable_telemetry = true",
    "models = []",
    "",
    "[[models]]",
    'name = "mistral-medium-latest"',
    'provider = "mistral"',
    'alias = "mistral-medium-latest"',
    "",
  ].join("\n");
  await fs.writeFile(path.join(home, "config.toml"), corrupt);
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(!/^models\s*=/m.test(raw), "inline models key must be removed");
  assert.match(raw, /^\[\[models\]\]$/m);
  const aliasCount = (raw.match(/^alias = "mistral-medium-latest"$/gm) || []).length;
  assert.equal(aliasCount, 1, "must not duplicate the models block");
  const mtime1 = (await fs.stat(path.join(home, "config.toml"))).mtimeMs;
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const mtime2 = (await fs.stat(path.join(home, "config.toml"))).mtimeMs;
  assert.equal(mtime2, mtime1, "repair must be idempotent");
});

test("ensureVibeConfigModel never appends [[models]] after a non-empty inline models array", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  const original = [
    'active_model = "custom-model"',
    'models = [{ name = "custom-model", provider = "mistral", alias = "custom-model" }]',
    "",
  ].join("\n");
  await fs.writeFile(path.join(home, "config.toml"), original);
  await config.ensureVibeConfigModel(home, "mistral-medium-latest");
  const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(raw.includes("custom-model"), "user models must be preserved");
  assert.ok(!/^\[\[models\]\]$/m.test(raw), "must not append AoT after an inline models array");
  assert.match(raw, /^active_model = "mistral-medium-latest"$/m);
});

test("ensureVibeTrustedFolder seeds cwd once and clears untrusted entry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-cwd-"));
  await config.ensureVibeTrustedFolder(home, cwd);
  const first = await fs.readFile(path.join(home, "trusted_folders.toml"), "utf8");
  assert.ok(first.includes(`trusted = ["${cwd}"]`));
  assert.ok(first.includes("untrusted = []"));
  await config.ensureVibeTrustedFolder(home, cwd);
  const second = await fs.readFile(path.join(home, "trusted_folders.toml"), "utf8");
  assert.equal(second, first);
  await fs.writeFile(path.join(home, "trusted_folders.toml"), `trusted = []\nuntrusted = ["${cwd}"]\n`);
  await config.ensureVibeTrustedFolder(home, cwd);
  const third = await fs.readFile(path.join(home, "trusted_folders.toml"), "utf8");
  assert.ok(third.includes(`trusted = ["${cwd}"]`));
  assert.ok(third.includes("untrusted = []"));
});

test("configHasMistralApiKey detects presence without exposing the value", () => {
  assert.equal(config.configHasMistralApiKey({ env: { MISTRAL_API_KEY: "sk-abc" } }), true);
  assert.equal(config.configHasMistralApiKey({ env: { MISTRAL_API_KEY: "  " } }), false);
  assert.equal(config.configHasMistralApiKey({ env: {} }), false);
  assert.equal(config.configHasMistralApiKey({}), false);
});

test("ui-parser maps acpx engine lines to transcript entries", () => {
  const ts = "2026-10-24T00:00:00.000Z";
  const session = uiParser.parseStdoutLine(
    JSON.stringify({ type: "acpx.session", agent: "custom", mode: "persistent", permissionMode: "approve-all", acpSessionId: "s-1" }),
    ts,
  );
  assert.equal(session[0].kind, "init");
  assert.equal(session[0].sessionId, "s-1");

  const delta = uiParser.parseStdoutLine(JSON.stringify({ type: "acpx.text_delta", text: "hello", channel: "assistant" }), ts);
  assert.deepEqual(delta, [{ kind: "assistant", ts, text: "hello", delta: true }]);

  const thought = uiParser.parseStdoutLine(JSON.stringify({ type: "acpx.text_delta", text: "hmm", channel: "thought" }), ts);
  assert.equal(thought[0].kind, "thinking");

  const tool = uiParser.parseStdoutLine(
    JSON.stringify({ type: "acpx.tool_call", name: "read_file", toolCallId: "t1", status: "completed", text: "done" }),
    ts,
  );
  assert.equal(tool[0].kind, "tool_call");
  assert.equal(tool[0].name, "read_file");
  assert.equal(tool[1].kind, "tool_result");
  assert.equal(tool[1].isError, false);

  const toolResult = uiParser.parseStdoutLine(
    JSON.stringify({ type: "acpx.tool_result", name: "shell", output: "ls ok", isError: false }),
    ts,
  );
  assert.equal(toolResult[0].kind, "tool_result");
  assert.equal(toolResult[0].content, "ls ok");

  const result = uiParser.parseStdoutLine(
    JSON.stringify({ type: "acpx.result", summary: "all done", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }),
    ts,
  );
  assert.equal(result[0].kind, "result");
  assert.equal(result[0].text, "all done");
  assert.equal(result[0].inputTokens, 10);

  const err = uiParser.parseStdoutLine(JSON.stringify({ type: "acpx.error", message: "boom" }), ts);
  assert.deepEqual(err, [{ kind: "stderr", ts, text: "boom" }]);

  const paperclipLine = uiParser.parseStdoutLine("[paperclip] Applied ACPX custom config model=mistral-medium-latest", ts);
  assert.deepEqual(paperclipLine, [{ kind: "system", ts, text: "[paperclip] Applied ACPX custom config model=mistral-medium-latest" }]);

  const plain = uiParser.parseStdoutLine("some random output", ts);
  assert.deepEqual(plain, [{ kind: "stdout", ts, text: "some random output" }]);

  assert.deepEqual(uiParser.parseStdoutLine("   ", ts), []);
});

test("testEnvironment fails actionably when the binary is missing and no key is set", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-envtest-"));
  const result = await testMod.testEnvironment({
    companyId: "co-test",
    adapterType: "mistral_vibe",
    config: {
      vibeAcpPath: "/nonexistent/vibe-acp",
      vibeHome: home,
      vibeAuthProbe: false,
    },
  });
  assert.equal(result.adapterType, "mistral_vibe");
  assert.equal(result.status, "fail");
  const missing = result.checks.find((c) => c.code === "mistral_vibe_binary_missing");
  assert.ok(missing);
  assert.equal(missing.level, "error");
  assert.ok(missing.hint.includes("vibeAcpPath"));
  const auth = result.checks.find((c) => c.code === "adapter_auth_missing");
  assert.ok(auth);
  assert.equal(auth.level, "error");
  const homeCheck = result.checks.find((c) => c.code === "mistral_vibe_home_writable");
  assert.ok(homeCheck);
  assert.equal(homeCheck.level, "info");
  for (const check of result.checks) {
    assert.ok(!JSON.stringify(check).includes("sk-"), "checks must never contain key material");
  }
});

test("testEnvironment passes with a fake vibe-acp on PATH and a key in env", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-bin-"));
  const fake = path.join(binDir, "vibe-acp");
  await fs.writeFile(fake, '#!/bin/sh\necho "vibe-acp 3.0.2"\n', { mode: 0o755 });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-envtest-"));
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  try {
    const result = await testMod.testEnvironment({
      companyId: "co-test",
      adapterType: "mistral_vibe",
      config: {
        vibeHome: home,
        vibeAuthProbe: false,
        env: { MISTRAL_API_KEY: "sk-fake-key-for-test" },
      },
    });
    const nodeCheck = result.checks.find((c) => c.code.startsWith("mistral_vibe_node_"));
    if (nodeCheck.level === "error") {
      // The sandbox runs Node 22 while the engine requires >= 24.11 (the
      // deployed Paperclip container runs Node 24.21). Verify the check is
      // present and actionable, then skip the pass assertion.
      assert.ok(nodeCheck.hint.includes("24.11.0"));
      assert.equal(result.status, "fail");
      return;
    }
    assert.equal(result.status, "pass", JSON.stringify(result.checks, null, 2));
    const version = result.checks.find((c) => c.code === "mistral_vibe_binary_version");
    assert.ok(version);
    assert.ok(version.message.includes("3.0.2"));
    const key = result.checks.find((c) => c.code === "mistral_vibe_api_key_present");
    assert.ok(key);
    for (const check of result.checks) {
      assert.ok(!JSON.stringify(check).includes("sk-fake-key-for-test"), "checks must never contain the key value");
    }
  } finally {
    process.env.PATH = savedPath ?? "";
  }
});

test("testEnvironment detects a key in VIBE_HOME/.env", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-bin-"));
  await fs.writeFile(path.join(binDir, "vibe-acp"), '#!/bin/sh\necho "vibe-acp 3.0.2"\n', { mode: 0o755 });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-envtest-"));
  await fs.writeFile(path.join(home, ".env"), "MISTRAL_API_KEY=sk-from-dotenv\n");
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  try {
    const result = await testMod.testEnvironment({
      companyId: "co-test",
      adapterType: "mistral_vibe",
      config: { vibeHome: home, vibeAuthProbe: false },
    });
    const key = result.checks.find((c) => c.code === "mistral_vibe_api_key_present");
    assert.ok(key);
    assert.ok(key.message.includes(".env"));
    assert.ok(!result.checks.some((c) => c.code === "adapter_auth_missing"));
    for (const check of result.checks) {
      assert.ok(!JSON.stringify(check).includes("sk-from-dotenv"));
    }
  } finally {
    process.env.PATH = savedPath ?? "";
  }
});

test("node version gate matches the engine requirement", () => {
  assert.equal(testMod.nodeVersionMeetsAcpMinimum("v24.11.0"), true);
  assert.equal(testMod.nodeVersionMeetsAcpMinimum("v24.10.9"), false);
  assert.equal(testMod.nodeVersionMeetsAcpMinimum("v25.0.0"), true);
  assert.equal(testMod.nodeVersionMeetsAcpMinimum("v22.13.0"), false);
});

const quotaMod = await import("../dist/server/quota.js");

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

test("getQuotaWindows reports credentials_unavailable without an admin key", async () => {
  const saved = process.env.MISTRAL_ADMIN_API_KEY;
  delete process.env.MISTRAL_ADMIN_API_KEY;
  try {
    const result = await quotaMod.getQuotaWindows();
    assert.equal(result.provider, "mistral");
    assert.equal(result.ok, false);
    assert.equal(result.errorFamily, "credentials_unavailable");
    assert.deepEqual(result.windows, []);
    assert.ok(result.error.includes("MISTRAL_ADMIN_API_KEY"));
    assert.ok(!JSON.stringify(result).includes("sk-"), "must not leak key material");
  } finally {
    if (saved !== undefined) process.env.MISTRAL_ADMIN_API_KEY = saved;
  }
});

test("getQuotaWindows maps usage + spend-limit into a monthly spend window", async () => {
  const saved = process.env.MISTRAL_ADMIN_API_KEY;
  process.env.MISTRAL_ADMIN_API_KEY = "admin-key-secret";
  const requested = [];
  try {
    await withMockFetch(
      async (url, init) => {
        requested.push(String(url));
        assert.equal(init.headers["x-api-key"], "admin-key-secret");
        assert.ok(!init.headers.Authorization, "admin endpoints use x-api-key, not Bearer");
        if (String(url).includes("/usage")) {
          return jsonResponse(200, {
            start_date: "2026-10-01T00:00:00Z",
            end_date: "2026-10-31T23:59:59Z",
            currency: "EUR",
            usage: {
              chat: { cost: 12.5 },
              vibe_usage: { cost: 30 },
            },
          });
        }
        if (String(url).includes("/spend-limit")) {
          return jsonResponse(200, { amount: 100, no_monthly_limit: false });
        }
        throw new Error(`unexpected url ${url}`);
      },
      async () => {
        const result = await quotaMod.getQuotaWindows();
        assert.equal(result.ok, true);
        assert.equal(result.provider, "mistral");
        assert.equal(result.source, "mistral-admin-api");
        assert.equal(result.windows.length, 1);
        const window = result.windows[0];
        assert.equal(window.label, "Vibe monthly spend");
        assert.equal(window.usedPercent, 30);
        assert.equal(window.resetsAt, "2026-10-31T23:59:59.000Z");
        assert.equal(window.valueLabel, "30 / 100 EUR spent");
        assert.ok(window.detail.includes("2026-10-01"));
      },
    );
    assert.equal(requested.length, 2);
    assert.ok(requested.some((url) => url.includes("/usage?month=")));
  } finally {
    if (saved === undefined) delete process.env.MISTRAL_ADMIN_API_KEY;
    else process.env.MISTRAL_ADMIN_API_KEY = saved;
  }
});

test("getQuotaWindows reports usage without percent when no monthly limit is set", async () => {
  const saved = process.env.MISTRAL_ADMIN_API_KEY;
  process.env.MISTRAL_ADMIN_API_KEY = "admin-key-secret";
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes("/usage")) {
          return jsonResponse(200, {
            start_date: "2026-10-01",
            end_date: "2026-10-31",
            currency: "USD",
            usage: { vibe_usage: { cost: 7.25 } },
          });
        }
        return jsonResponse(200, { amount: null, no_monthly_limit: true });
      },
      async () => {
        const result = await quotaMod.getQuotaWindows();
        assert.equal(result.ok, true);
        const window = result.windows[0];
        assert.equal(window.label, "Vibe monthly usage");
        assert.equal(window.usedPercent, null);
        assert.equal(window.valueLabel, "7.25 USD spent this period");
      },
    );
  } finally {
    if (saved === undefined) delete process.env.MISTRAL_ADMIN_API_KEY;
    else process.env.MISTRAL_ADMIN_API_KEY = saved;
  }
});

test("getQuotaWindows maps 401/403 to auth error families", async () => {
  const saved = process.env.MISTRAL_ADMIN_API_KEY;
  process.env.MISTRAL_ADMIN_API_KEY = "admin-key-secret";
  try {
    await withMockFetch(
      async () => jsonResponse(401, { message: "unauthorized" }),
      async () => {
        const result = await quotaMod.getQuotaWindows();
        assert.equal(result.ok, false);
        assert.equal(result.errorFamily, "authentication_required");
        assert.ok(!JSON.stringify(result).includes("admin-key-secret"));
      },
    );
    await withMockFetch(
      async () => jsonResponse(403, { message: "forbidden" }),
      async () => {
        const result = await quotaMod.getQuotaWindows();
        assert.equal(result.ok, false);
        assert.equal(result.errorFamily, "permission_denied");
      },
    );
  } finally {
    if (saved === undefined) delete process.env.MISTRAL_ADMIN_API_KEY;
    else process.env.MISTRAL_ADMIN_API_KEY = saved;
  }
});

test("getQuotaWindows reports provider_unavailable on network failure", async () => {
  const saved = process.env.MISTRAL_ADMIN_API_KEY;
  process.env.MISTRAL_ADMIN_API_KEY = "admin-key-secret";
  try {
    await withMockFetch(
      async () => {
        throw new Error("socket hangup");
      },
      async () => {
        const result = await quotaMod.getQuotaWindows();
        assert.equal(result.ok, false);
        assert.equal(result.errorFamily, "provider_unavailable");
        assert.ok(result.error.includes("socket hangup"));
      },
    );
  } finally {
    if (saved === undefined) delete process.env.MISTRAL_ADMIN_API_KEY;
    else process.env.MISTRAL_ADMIN_API_KEY = saved;
  }
});

test("createServerAdapter exposes getQuotaWindows", () => {
  const adapter = server.createServerAdapter();
  assert.equal(typeof adapter.getQuotaWindows, "function");
});
