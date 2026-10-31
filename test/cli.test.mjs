import assert from "node:assert/strict";
import { test } from "node:test";

const config = await import("../dist/server/config.js");
const server = await import("../dist/server/index.js");
const testMod = await import("../dist/server/test.js");

test("resolveExecutionEngine defaults to acp", () => {
  assert.equal(config.resolveExecutionEngine({}), "acp");
  assert.equal(config.resolveExecutionEngine({ engine: "" }), "acp");
  assert.equal(config.resolveExecutionEngine({ engine: "acp" }), "acp");
});

test("resolveExecutionEngine selects cli when engine is cli", () => {
  assert.equal(config.resolveExecutionEngine({ engine: "cli" }), "cli");
  assert.equal(config.resolveExecutionEngine({ engine: "CLI" }), "cli");
  assert.equal(config.resolveExecutionEngine({ engine: " cli " }), "cli");
});

test("resolveExecutionEngine ignores unknown engines", () => {
  assert.equal(config.resolveExecutionEngine({ engine: "vibe" }), "acp");
  assert.equal(config.resolveExecutionEngine({ engine: 42 }), "acp");
});

test("resolveVibeCliCommand resolution order: config → env → PATH", async () => {
  const fromConfig = await config.resolveVibeCliCommand({ vibeCliPath: "/usr/local/bin/vibe" });
  assert.deepEqual(fromConfig, { command: "/usr/local/bin/vibe", source: "config" });

  const previous = process.env[config.VIBE_CLI_ENV_VAR];
  try {
    delete process.env[config.VIBE_CLI_ENV_VAR];
    const fromPath = await config.resolveVibeCliCommand({});
    assert.deepEqual(fromPath, { command: "vibe", source: "path" });

    process.env[config.VIBE_CLI_ENV_VAR] = "/opt/vibe/bin/vibe";
    const fromEnv = await config.resolveVibeCliCommand({});
    assert.deepEqual(fromEnv, { command: "/opt/vibe/bin/vibe", source: "env" });
  } finally {
    if (previous === undefined) {
      delete process.env[config.VIBE_CLI_ENV_VAR];
    } else {
      process.env[config.VIBE_CLI_ENV_VAR] = previous;
    }
  }
});

test("resolveVibeCliCommand config wins over env", async () => {
  const previous = process.env[config.VIBE_CLI_ENV_VAR];
  process.env[config.VIBE_CLI_ENV_VAR] = "/from/env/vibe";
  try {
    const resolved = await config.resolveVibeCliCommand({ vibeCliPath: "/from/config/vibe" });
    assert.deepEqual(resolved, { command: "/from/config/vibe", source: "config" });
  } finally {
    if (previous === undefined) {
      delete process.env[config.VIBE_CLI_ENV_VAR];
    } else {
      process.env[config.VIBE_CLI_ENV_VAR] = previous;
    }
  }
});

test("CLI agent profile resolution defaults to auto-approve", () => {
  assert.equal(config.resolveCliAgent({}), "auto-approve");
  assert.equal(config.resolveCliAgent({ cliAgent: "" }), "auto-approve");
  assert.equal(config.resolveCliAgent({ cliAgent: "smart-approve" }), "smart-approve");
  assert.equal(config.resolveCliAgent({ cliAgent: "accept-edits" }), "accept-edits");
  assert.equal(config.resolveCliAgent({ cliAgent: "default" }), "default");
  assert.equal(config.resolveCliAgent({ cliAgent: "bogus" }), "auto-approve");
});

const cliExecute = await import("../dist/server/cli-execute.js");

test("buildVibeCliArgs fresh session", () => {
  const args = cliExecute.buildVibeCliArgs({
    promptFilePath: "/tmp/prompt.md",
    cwd: "/workspace/repo",
    outputDir: "/tmp/run-out",
    resumeSessionId: null,
    agent: "auto-approve",
  });
  assert.deepEqual(args, [
    "-p",
    "--prompt-file",
    "/tmp/prompt.md",
    "--output",
    "streaming",
    "--agent",
    "auto-approve",
    "--trust",
    "--workdir",
    "/workspace/repo",
    "--output-dir",
    "/tmp/run-out",
  ]);
});

test("buildVibeCliArgs resume session", () => {
  const args = cliExecute.buildVibeCliArgs({
    promptFilePath: "/tmp/prompt.md",
    cwd: "/workspace/repo",
    outputDir: "/tmp/run-out",
    resumeSessionId: "785f74c1-6c30-c981-6878-6c1f9e1b30ce",
    agent: "smart-approve",
  });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "785f74c1-6c30-c981-6878-6c1f9e1b30ce");
  assert.ok(args.includes("smart-approve"));
});

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const fixturesDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "vibe-cli-stream");

async function parseFixture(name) {
  const raw = await fs.readFile(path.join(fixturesDir, name), "utf8");
  const parser = cliExecute.createVibeCliStreamParser();
  const lines = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    lines.push(...parser.parseLine(line));
  }
  return { parser, lines };
}

test("stream parser: happy path emits tool line and captures summary + session", async () => {
  const { parser, lines } = await parseFixture("happy.ndjson");
  const joined = lines.join("\n");
  assert.ok(joined.includes("bash: echo hello-from-tool"), "tool summary line missing");
  assert.ok(joined.includes("hello-from-tool"), "tool output excerpt missing");
  assert.ok(!joined.includes("Use the bash tool"), "user prompt echo must not be re-emitted");
  assert.equal(parser.state.sessionId, "0af210c2-d95a-5c8c-16e1-999f38d51fdb");
  assert.equal(
    parser.state.lastAssistantText,
    "`hello-from-tool` — the command ran successfully (exit code 0).",
  );
});

test("stream parser: approval callback surfaces an auto-denied notice", async () => {
  const { parser, lines } = await parseFixture("approval-denied.ndjson");
  const joined = lines.join("\n");
  assert.ok(
    joined.includes("[paperclip]") && joined.includes("needs approval"),
    "approval notice line missing",
  );
  assert.ok(joined.includes("denied"), "denial must be visible in the transcript");
  assert.equal(parser.state.approvalsDenied, 1);
  assert.equal(
    parser.state.lastAssistantText,
    "The command was blocked — the approval callback denied the tool execution.",
  );
  assert.equal(parser.state.sessionId, "374655e6-97d9-d126-e4dc-dbd11cdfab2d");
});

test("stream parser: non-JSON lines pass through unchanged", () => {
  const parser = cliExecute.createVibeCliStreamParser();
  const emitted = parser.parseLine("update available: vibe 3.0.4");
  assert.deepEqual(emitted, ["update available: vibe 3.0.4"]);
});

test("stream parser: blank and unparseable JSON lines are ignored", () => {
  const parser = cliExecute.createVibeCliStreamParser();
  assert.deepEqual(parser.parseLine(""), []);
  assert.deepEqual(parser.parseLine("   "), []);
  assert.deepEqual(parser.parseLine("{not json"), ["{not json"]);
});

test("stream parser: effect updates emit once (running then completed dedupe)", async () => {
  const parser = cliExecute.createVibeCliStreamParser();
  const completed = JSON.parse((await fs.readFile(path.join(fixturesDir, "happy.ndjson"), "utf8")).split("\n")[1]);
  const running = JSON.parse(JSON.stringify(completed));
  running.state.status = "running";
  const firstEmission = parser.parseLine(JSON.stringify(running));
  const secondEmission = parser.parseLine(JSON.stringify(completed));
  assert.equal(firstEmission.length, 0, "running effect must not emit yet");
  assert.ok(secondEmission.length > 0, "completed effect must emit");
});

test("stream parser: reasoning entries are not emitted", async () => {
  const { lines } = await parseFixture("approval-denied.ndjson");
  assert.ok(!lines.some((line) => line.includes("The user asks to run rm")), "reasoning must stay private");
});

import os from "node:os";

test("cli session state: round-trip, missing, corrupt, and clear", async () => {
  const vibeHome = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-cli-home-"));
  try {
    assert.equal((await cliExecute.readCliSessionState(vibeHome)).sessionId, null);
    await cliExecute.writeCliSessionState(vibeHome, "abc-123");
    assert.equal((await cliExecute.readCliSessionState(vibeHome)).sessionId, "abc-123");
    await fs.writeFile(path.join(vibeHome, "paperclip-cli-session.json"), "{corrupt", "utf8");
    assert.equal((await cliExecute.readCliSessionState(vibeHome)).sessionId, null);
    await cliExecute.writeCliSessionState(vibeHome, "def-456");
    await cliExecute.writeCliSessionState(vibeHome, null);
    assert.equal((await cliExecute.readCliSessionState(vibeHome)).sessionId, null);
  } finally {
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("parseVibeCliExport maps export.json to adapter usage fields", () => {
  const exportJson = JSON.stringify({
    schema_version: 1,
    session_id: "785f74c1-6c30-c981-6878-6c1f9e1b30ce",
    usage: { input_tokens: 9451, output_tokens: 3, cached_input_tokens: 2624, total_tokens: 9454 },
    cost_usd: 0.0123,
    stop_reason: null,
    outcome: "finished",
    exit_code: 0,
    vibe_version: "3.0.3",
  });
  const parsed = cliExecute.parseVibeCliExport(exportJson);
  assert.equal(parsed.sessionId, "785f74c1-6c30-c981-6878-6c1f9e1b30ce");
  assert.deepEqual(parsed.usage, { inputTokens: 9451, outputTokens: 3, cachedInputTokens: 2624 });
  assert.equal(parsed.costUsd, 0.0123);
  assert.equal(parsed.outcome, "finished");
});

test("parseVibeCliExport tolerates missing usage and null input", () => {
  assert.equal(cliExecute.parseVibeCliExport("not json"), null);
  const minimal = cliExecute.parseVibeCliExport(JSON.stringify({ session_id: "s1" }));
  assert.equal(minimal.sessionId, "s1");
  assert.deepEqual(minimal.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  assert.equal(minimal.costUsd, null);
});

// ---------------------------------------------------------------------------
// Executor E2E against a fake vibe CLI
// ---------------------------------------------------------------------------

const FAKE_VIBE = `#!/bin/sh
# Fake vibe CLI for adapter tests. Behavior via FAKE_VIBE_MODE:
#   ok            emit streaming entries + export.json, exit 0
#   resume-fails  exit 1 with "session not found" when --resume is passed
#   sleep         sleep 30 (timeout/abort tests)
#   no-export     emit entries but write no export.json
OUT=""
RESUME=0
while [ $# -gt 0 ]; do
  case "$1" in
    --output-dir) OUT="$2"; shift 2 ;;
    --resume) RESUME=1; shift 2 ;;
    *) shift ;;
  esac
done
MODE="$FAKE_VIBE_MODE"
if [ "$MODE" = "resume-fails" ] && [ "$RESUME" = "1" ]; then
  echo "Error: session not found" >&2
  exit 1
fi
if [ "$MODE" = "sleep" ]; then
  sleep 30
  exit 0
fi
if [ "$RESUME" = "1" ]; then
  : > "$FAKE_RESUME_MARKER"
fi
emit() { printf '%s\\n' "$1"; }
emit '{"id":"assistant-1","sessionId":"fake-session-1","type":"message","role":"assistant","content":[{"type":"text","text":"All done."}],"source":"harness","outcome":{"type":"committed"}}'
if [ "$MODE" != "no-export" ] && [ -n "$OUT" ]; then
  cat > "$OUT/export.json" << 'JSON'
{"session_id":"fake-session-1","usage":{"input_tokens":100,"output_tokens":5,"cached_input_tokens":10,"total_tokens":115},"cost_usd":0.01,"stop_reason":null,"outcome":"finished","exit_code":0,"vibe_version":"3.0.3"}
JSON
fi
exit 0
`;

async function makeFakeVibe(home) {
  const scriptPath = path.join(home, "fake-vibe");
  await fs.writeFile(scriptPath, FAKE_VIBE, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

function makeCliCtx({ config, context = {}, onLog } = {}) {
  const logs = [];
  const meta = [];
  const spawns = [];
  return {
    ctx: {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "co-1", name: "Agent One" },
      config,
      context,
      onLog:
        onLog ??
        (async (stream, chunk) => {
          logs.push({ stream, chunk });
        }),
      onMeta: async (m) => meta.push(m),
      onSpawn: async (s) => spawns.push(s),
    },
    logs,
    meta,
    spawns,
  };
}

async function cliE2EHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-cli-e2e-"));
  return root;
}

test("cli executor: happy path spawns, streams, reports usage and persists session", async () => {
  const root = await cliE2EHome();
  try {
    const fakeVibe = await makeFakeVibe(root);
    const { ctx, logs, meta, spawns } = makeCliCtx({
      config: {
        engine: "cli",
        vibeCliPath: fakeVibe,
        vibeHome: path.join(root, "home"),
        env: { MISTRAL_API_KEY: "test-key" },
      },
    });
    const result = await cliExecute.createMistralVibeCliExecutor()(ctx);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.sessionId, "fake-session-1");
    assert.equal(result.usageBasis, "per_run");
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 10 });
    assert.equal(result.costUsd, 0.01);
    assert.equal(result.provider, "mistral");
    assert.equal(result.model, "mistral-medium-latest");
    assert.equal(result.summary, "All done.");
    assert.ok(logs.some((entry) => entry.chunk.includes("All done.")));
    assert.equal(spawns.length, 1);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].command, fakeVibe);
    const state = await cliExecute.readCliSessionState(path.join(root, "home"));
    assert.equal(state.sessionId, "fake-session-1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cli executor: resume failure falls back to a fresh session", async () => {
  const root = await cliE2EHome();
  try {
    process.env.FAKE_VIBE_MODE = "resume-fails";
    const fakeVibe = await makeFakeVibe(root);
    const vibeHome = path.join(root, "home");
    await fs.mkdir(vibeHome, { recursive: true });
    await cliExecute.writeCliSessionState(vibeHome, "stale-session");
    const { ctx, logs } = makeCliCtx({
      config: { engine: "cli", vibeCliPath: fakeVibe, vibeHome, env: {} },
    });
    const result = await cliExecute.createMistralVibeCliExecutor()(ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(
      logs.some((entry) => entry.chunk.includes("fresh session")),
      "fallback note must appear in the transcript",
    );
    const state = await cliExecute.readCliSessionState(vibeHome);
    assert.equal(state.sessionId, "fake-session-1");
  } finally {
    delete process.env.FAKE_VIBE_MODE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cli executor: cliFreshSession skips the stored resume id", async () => {
  const root = await cliE2EHome();
  try {
    process.env.FAKE_VIBE_MODE = "ok";
    const fakeVibe = await makeFakeVibe(root);
    const vibeHome = path.join(root, "home");
    await fs.mkdir(vibeHome, { recursive: true });
    await cliExecute.writeCliSessionState(vibeHome, "old-session");
    process.env.FAKE_RESUME_MARKER = path.join(root, "resume-used");
    const { ctx } = makeCliCtx({
      config: { engine: "cli", vibeCliPath: fakeVibe, vibeHome, env: {}, cliFreshSession: true },
    });
    const result = await cliExecute.createMistralVibeCliExecutor()(ctx);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.stat(path.join(root, "resume-used")).then(() => true, () => false), false);
  } finally {
    delete process.env.FAKE_VIBE_MODE;
    delete process.env.FAKE_RESUME_MARKER;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cli executor: timeout kills the process group and reports timedOut", async () => {
  const root = await cliE2EHome();
  try {
    process.env.FAKE_VIBE_MODE = "sleep";
    const fakeVibe = await makeFakeVibe(root);
    const { ctx } = makeCliCtx({
      config: {
        engine: "cli",
        vibeCliPath: fakeVibe,
        vibeHome: path.join(root, "home"),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
      },
    });
    const result = await cliExecute.createMistralVibeCliExecutor()(ctx);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  } finally {
    delete process.env.FAKE_VIBE_MODE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cli executor: missing export.json still returns a result", async () => {
  const root = await cliE2EHome();
  try {
    process.env.FAKE_VIBE_MODE = "no-export";
    const fakeVibe = await makeFakeVibe(root);
    const { ctx } = makeCliCtx({
      config: { engine: "cli", vibeCliPath: fakeVibe, vibeHome: path.join(root, "home"), env: {} },
    });
    const result = await cliExecute.createMistralVibeCliExecutor()(ctx);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, "All done.");
    assert.equal(result.usage, undefined);
  } finally {
    delete process.env.FAKE_VIBE_MODE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cli executor: prompt assembly renders the agent template and overrides", () => {
  const prompt = cliExecute.buildVibeCliPrompt({
    config: {},
    context: {},
    agent: { id: "agent-1", companyId: "co-1", name: "Agent One" },
    runId: "run-1",
    resumedSession: false,
    instructions: null,
  });
  assert.ok(prompt.includes("You are agent agent-1 (Agent One)."), prompt.slice(0, 200));
  const custom = cliExecute.buildVibeCliPrompt({
    config: { promptTemplate: "Task for {{agent.id}} on run {{run.id}}" },
    context: {},
    agent: { id: "agent-1", companyId: "co-1", name: "Agent One" },
    runId: "run-9",
    resumedSession: true,
    instructions: "Be excellent to each other.",
  });
  assert.ok(custom.includes("Task for agent-1 on run run-9"));
  assert.ok(custom.includes("Be excellent to each other."));
});

// ---------------------------------------------------------------------------
// Engine dispatch + config schema
// ---------------------------------------------------------------------------

test("server adapter dispatches engine=cli to the CLI executor", async () => {
  const root = await cliE2EHome();
  try {
    process.env.FAKE_VIBE_MODE = "ok";
    const fakeVibe = await makeFakeVibe(root);
    const { ctx } = makeCliCtx({
      config: { engine: "cli", vibeCliPath: fakeVibe, vibeHome: path.join(root, "home"), env: {} },
    });
    const result = await server.createServerAdapter().execute(ctx);
    assert.equal(result.summary, "All done.");
    assert.equal(result.sessionId, "fake-session-1");
  } finally {
    delete process.env.FAKE_VIBE_MODE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("config schema: engine select gates lane-specific fields", () => {
  const schema = server.createServerAdapter().getConfigSchema();
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  const engine = fields.get("engine");
  assert.ok(engine, "engine field missing");
  assert.equal(engine.type, "select");
  assert.equal(engine.default, "acp");
  assert.deepEqual(
    engine.options.map((option) => option.value),
    ["acp", "cli"],
  );

  const acpGated = fields.get("vibeAcpPath");
  assert.deepEqual(acpGated?.meta?.visibleWhen, { key: "engine", value: "acp" });

  for (const key of ["vibeCliPath", "cliAgent", "cliFreshSession"]) {
    const field = fields.get(key);
    assert.ok(field, `${key} field missing`);
    assert.deepEqual(field.meta?.visibleWhen, { key: "engine", value: "cli" }, `${key} must be gated to cli`);
  }

  const cliAgent = fields.get("cliAgent");
  assert.equal(cliAgent.default, "auto-approve");
  assert.ok(
    cliAgent.options.some((option) => option.value === "auto-approve") &&
      cliAgent.options.some((option) => option.value === "smart-approve"),
  );

  const shared = fields.get("timeoutSec");
  assert.ok(shared, "timeoutSec field missing");
  assert.equal(shared.meta, undefined, "shared fields must not be gated");
});

test("config schema: ACP-only runtime fields are gated to engine=acp", () => {
  const schema = server.createServerAdapter().getConfigSchema();
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  assert.deepEqual(fields.get("mode")?.meta?.visibleWhen, { key: "engine", value: "acp" });
  assert.deepEqual(fields.get("permissionMode")?.meta?.visibleWhen, { key: "engine", value: "acp" });
  assert.deepEqual(fields.get("nonInteractivePermissions")?.meta?.visibleWhen, { key: "engine", value: "acp" });
  assert.deepEqual(fields.get("warmHandleIdleMs")?.meta?.visibleWhen, { key: "engine", value: "acp" });
});

// ---------------------------------------------------------------------------
// Environment test branching per engine
// ---------------------------------------------------------------------------

test("testEnvironment engine=cli probes the vibe CLI and skips the ACP Node requirement", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-clibin-"));
  const fake = path.join(binDir, "vibe");
  await fs.writeFile(fake, '#!/bin/sh\necho "vibe 2.26.1"\n', { mode: 0o755 });
  await fs.chmod(fake, 0o755);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-envtest-"));
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  try {
    const result = await testMod.testEnvironment({
      companyId: "co-test",
      adapterType: "mistral_vibe",
      config: {
        engine: "cli",
        vibeHome: home,
        vibeAuthProbe: false,
        env: { MISTRAL_API_KEY: "sk-fake-key-for-test" },
      },
    });
    assert.equal(result.status, "pass", JSON.stringify(result.checks, null, 2));
    assert.ok(
      !result.checks.some((c) => c.code.startsWith("mistral_vibe_node_")),
      "the ACP engine Node requirement must not gate the CLI engine",
    );
    const resolved = result.checks.find((c) => c.code === "mistral_vibe_binary_resolvable");
    assert.ok(resolved, "binary resolvable check missing");
    assert.ok(resolved.message.includes("vibe CLI"), resolved.message);
    const version = result.checks.find((c) => c.code === "mistral_vibe_binary_version");
    assert.ok(version);
    assert.ok(version.message.includes("2.26.1"));
    const key = result.checks.find((c) => c.code === "mistral_vibe_api_key_present");
    assert.ok(key);
    assert.ok(!JSON.stringify(result.checks).includes("sk-fake-key-for-test"));
  } finally {
    process.env.PATH = savedPath ?? "";
    await fs.rm(binDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("testEnvironment engine=cli fails actionably when the CLI binary is missing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-envtest-"));
  const result = await testMod.testEnvironment({
    companyId: "co-test",
    adapterType: "mistral_vibe",
    config: {
      engine: "cli",
      vibeCliPath: "/nonexistent/vibe",
      vibeHome: home,
      vibeAuthProbe: false,
    },
  });
  assert.equal(result.status, "fail");
  const missing = result.checks.find((c) => c.code === "mistral_vibe_binary_missing");
  assert.ok(missing);
  assert.equal(missing.level, "error");
  assert.ok(missing.hint.includes("vibeCliPath"), missing.hint);
  assert.ok(missing.hint.includes("PAPERCLIP_VIBE_CLI_PATH"), missing.hint);
  const auth = result.checks.find((c) => c.code === "adapter_auth_missing");
  assert.ok(auth);
  await fs.rm(home, { recursive: true, force: true });
});

test("testEnvironment default engine still probes vibe-acp", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-acpbin-"));
  const fake = path.join(binDir, "vibe-acp");
  await fs.writeFile(fake, '#!/bin/sh\necho "vibe-acp 3.0.2"\n', { mode: 0o755 });
  await fs.chmod(fake, 0o755);
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
    const resolved = result.checks.find((c) => c.code === "mistral_vibe_binary_resolvable");
    assert.ok(resolved);
    assert.ok(resolved.message.includes("vibe-acp"), resolved.message);
    assert.ok(result.checks.some((c) => c.code.startsWith("mistral_vibe_node_")), "acp engine keeps the Node check");
  } finally {
    process.env.PATH = savedPath ?? "";
    await fs.rm(binDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});
