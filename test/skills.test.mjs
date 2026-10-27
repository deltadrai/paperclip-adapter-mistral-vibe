import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const skills = await import("../dist/server/skills.js");
const server = await import("../dist/server/index.js");

const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";

async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Create a fake materialized Paperclip skill source directory. */
async function makeSkillSource(root, name, body = `# ${name}\nskill body`) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

function entry(key, runtimeName, source, extra = {}) {
  return { key, runtimeName, source, ...extra };
}

function ctxWith(config) {
  return { agentId: AGENT_ID, companyId: COMPANY_ID, adapterType: "mistral_vibe", config };
}

// ---------------------------------------------------------------------------
// skillsHome resolution
// ---------------------------------------------------------------------------

test("resolveMistralVibeSkillsHome appends skills to the configured vibeHome", () => {
  const home = skills.resolveMistralVibeSkillsHome(
    { vibeHome: "/opt/vibe-homes/agent-1" },
    COMPANY_ID,
    AGENT_ID,
  );
  assert.equal(home, "/opt/vibe-homes/agent-1/skills");
});

test("resolveMistralVibeSkillsHome derives the per-agent default from PAPERCLIP_HOME", () => {
  const tmpHome = os.tmpdir();
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = tmpHome;
  process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  try {
    const home = skills.resolveMistralVibeSkillsHome({}, COMPANY_ID, AGENT_ID);
    const expected = path.join(
      tmpHome,
      "instances",
      "test-instance",
      "companies",
      COMPANY_ID,
      "mistral-vibe",
      "agents",
      AGENT_ID,
      "home",
      "skills",
    );
    assert.equal(home, expected);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
  }
});

// ---------------------------------------------------------------------------
// syncMistralVibeSkills
// ---------------------------------------------------------------------------

test("syncMistralVibeSkills symlinks desired skills into the agent skills home", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const sourceB = await makeSkillSource(sources, "skill-b");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [
        entry("github/1/skill-a", "skill-a", sourceA),
        entry("github/1/skill-b", "skill-b", sourceB),
      ],
    };
    const snapshot = await skills.syncMistralVibeSkills(ctxWith(config), ["github/1/skill-b"]);

    const target = path.join(vibeHome, "skills", "skill-b");
    const stat = await fs.lstat(target);
    assert.equal(stat.isSymbolicLink(), true, "skill-b should be a symlink");
    const linked = await fs.realpath(path.join(vibeHome, "skills", "skill-b"));
    assert.equal(linked, await fs.realpath(sourceB));
    const body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    assert.match(body, /# skill-b/);

    assert.equal(snapshot.adapterType, "mistral_vibe");
    assert.equal(snapshot.supported, true);
    assert.ok(snapshot.desiredSkills.includes("github/1/skill-b"), "desiredSkills should include skill-b");
    const entryB = snapshot.entries.find((e) => e.key === "github/1/skill-b");
    assert.equal(entryB.state, "installed");
    const entryA = snapshot.entries.find((e) => e.key === "github/1/skill-a");
    assert.equal(entryA.state, "available");
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("syncMistralVibeSkills skips skills with a missing source", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [
        entry("github/1/skill-a", "skill-a", sourceA),
        entry("github/1/gone", "gone", path.join(sources, "gone"), { sourceStatus: "missing" }),
      ],
    };
    const snapshot = await skills.syncMistralVibeSkills(ctxWith(config), ["github/1/gone"]);
    await assert.rejects(fs.lstat(path.join(vibeHome, "skills", "gone")));
    const gone = snapshot.entries.find((e) => e.key === "github/1/gone");
    assert.equal(gone.state, "missing");
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("syncMistralVibeSkills removes stale managed links but keeps external skills", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const sourceB = await makeSkillSource(sources, "skill-b");
    const runtimeEntries = [
      entry("github/1/skill-a", "skill-a", sourceA),
      entry("github/1/skill-b", "skill-b", sourceB),
    ];

    await skills.syncMistralVibeSkills(ctxWith({ vibeHome, paperclipRuntimeSkills: runtimeEntries }), [
      "github/1/skill-a",
    ]);
    // The first sync must actually create the managed link.
    const linkedA = await fs.lstat(path.join(vibeHome, "skills", "skill-a"));
    assert.equal(linkedA.isSymbolicLink(), true);

    // User-installed skill in the same directory must survive every sync.
    await makeSkillSource(path.join(vibeHome, "skills"), "user-skill", "# user\n");

    // Unassign skill-a, assign skill-b.
    const snapshot = await skills.syncMistralVibeSkills(
      ctxWith({ vibeHome, paperclipRuntimeSkills: runtimeEntries }),
      ["github/1/skill-b"],
    );

    await assert.rejects(fs.lstat(path.join(vibeHome, "skills", "skill-a")));
    const userBody = await fs.readFile(path.join(vibeHome, "skills", "user-skill", "SKILL.md"), "utf8");
    assert.match(userBody, /# user/);
    const entryA = snapshot.entries.find((e) => e.key === "github/1/skill-a");
    assert.equal(entryA.state, "available");
    const external = snapshot.entries.find((e) => e.runtimeName === "user-skill");
    assert.equal(external.state, "external");
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("syncMistralVibeSkills does not overwrite a user-installed directory with the same name", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a", "# materialized\n");
    await makeSkillSource(path.join(vibeHome, "skills"), "skill-a", "# user-installed\n");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [entry("github/1/skill-a", "skill-a", sourceA)],
    };
    await skills.syncMistralVibeSkills(ctxWith(config), ["github/1/skill-a"]);
    const body = await fs.readFile(path.join(vibeHome, "skills", "skill-a", "SKILL.md"), "utf8");
    assert.match(body, /# user-installed/);
    const stat = await fs.lstat(path.join(vibeHome, "skills", "skill-a"));
    assert.equal(stat.isSymbolicLink(), false);
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listMistralVibeSkills
// ---------------------------------------------------------------------------

test("listMistralVibeSkills reports a persistent snapshot of installed skills", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [entry("github/1/skill-a", "skill-a", sourceA)],
      paperclipSkillSync: { desiredSkills: ["github/1/skill-a"] },
    };
    const snapshot = await skills.listMistralVibeSkills(ctxWith(config));
    assert.equal(snapshot.adapterType, "mistral_vibe");
    assert.equal(snapshot.mode, "persistent");
    assert.equal(snapshot.supported, true);
    assert.ok(snapshot.desiredSkills.includes("github/1/skill-a"));
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("listMistralVibeSkills auto-includes the operational paperclip skill", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const sourceOp = await makeSkillSource(sources, "paperclip");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [
        entry("github/1/skill-a", "skill-a", sourceA),
        entry("paperclipai/paperclip/paperclip", "paperclip", sourceOp),
      ],
      paperclipSkillSync: { desiredSkills: ["github/1/skill-a"] },
    };
    const snapshot = await skills.listMistralVibeSkills(ctxWith(config));
    assert.ok(
      snapshot.desiredSkills.includes("paperclipai/paperclip/paperclip"),
      "operational skill must be desired",
    );
    assert.ok(
      snapshot.desiredSkills.includes("github/1/skill-a"),
      "explicit desired skill must stay desired",
    );
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureMistralVibeSkillsLinked (executor-time self-healing, both engines)
// ---------------------------------------------------------------------------

test("ensureMistralVibeSkillsLinked links and repairs desired skills idempotently", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [entry("github/1/skill-a", "skill-a", sourceA)],
      paperclipSkillSync: { desiredSkills: ["github/1/skill-a"] },
    };

    await skills.ensureMistralVibeSkillsLinked(config, COMPANY_ID, AGENT_ID);
    const target = path.join(vibeHome, "skills", "skill-a");
    let body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    assert.match(body, /# skill-a/);

    // Self-heal: operator deletes the link; the next run restores it.
    await fs.rm(target, { force: true });
    await skills.ensureMistralVibeSkillsLinked(config, COMPANY_ID, AGENT_ID);
    body = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    assert.match(body, /# skill-a/);

    // Idempotent: a second call leaves the same link in place.
    const before = await fs.readlink(target);
    await skills.ensureMistralVibeSkillsLinked(config, COMPANY_ID, AGENT_ID);
    const after = await fs.readlink(target);
    assert.equal(before, after);
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

test("ensureMistralVibeSkillsLinked does nothing when no skills are desired", async () => {
  const sources = await makeTmpDir("vibe-skills-sources-");
  const vibeHome = await makeTmpDir("vibe-skills-home-");
  try {
    const sourceA = await makeSkillSource(sources, "skill-a");
    const config = {
      vibeHome,
      paperclipRuntimeSkills: [entry("github/1/skill-a", "skill-a", sourceA)],
    };
    await skills.ensureMistralVibeSkillsLinked(config, COMPANY_ID, AGENT_ID);
    await assert.rejects(fs.lstat(path.join(vibeHome, "skills", "skill-a")));
  } finally {
    await fs.rm(sources, { recursive: true, force: true });
    await fs.rm(vibeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Server adapter wiring
// ---------------------------------------------------------------------------

test("server adapter exposes the skill contract for both engines", async () => {
  const adapter = server.createServerAdapter();
  assert.equal(typeof adapter.listSkills, "function");
  assert.equal(typeof adapter.syncSkills, "function");
  assert.equal(adapter.acp?.skillsMode, "ephemeral");
  assert.equal(adapter.requiresMaterializedRuntimeSkills, true);
});
