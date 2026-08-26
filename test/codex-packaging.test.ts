// C2 acceptance: the COMMITTED plugin build at codex/dist/ — the exact files
// an installed plugin executes — runs under the PLUGIN_DATA/CODEX_HOME env
// contract with a real captured hook stdin. Not the dist-test compilation
// the other suites import; if the committed output is stale or missing,
// these fail. Mirrors test/packaging.test.ts's own acceptance for claude-code/dist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import { writePendingConfig, pendingConfigPath } from "../src/codex-connect.js";

// pnpm test always runs from the repository root.
const hookBin = join(process.cwd(), "codex", "dist", "codex-hook.js");
const connectBin = join(process.cwd(), "codex", "dist", "codex-connect.js");
const fixturePath = join(process.cwd(), "test", "testdata", "codex_session.jsonl");

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Trinity Test",
    GIT_AUTHOR_EMAIL: "test@trinity.dev",
    GIT_COMMITTER_NAME: "Trinity Test",
    GIT_COMMITTER_EMAIL: "test@trinity.dev",
  };
}

function initRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

function runHookBinary(dataDir: string, eventName: string, stdin: string): void {
  // execFileSync throws on a non-zero exit — the hook contract is exit 0, always.
  execFileSync("node", [hookBin, eventName], { input: stdin, env: { ...process.env, PLUGIN_DATA: dataDir } });
}

function loadFixtureLine(eventName: string): Record<string, unknown> {
  const lines = readFileSync(fixturePath, "utf8").trim().split("\n");
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.hook_event_name === eventName) return parsed;
  }
  throw new Error(`fixture has no ${eventName} line`);
}

test("the committed hook and connect binaries exist where hooks.json / the skill point", () => {
  assert.ok(existsSync(hookBin), `${hookBin} is missing — run pnpm build:codex and commit the output`);
  assert.ok(existsSync(connectBin), `${connectBin} is missing — run pnpm build:codex and commit the output`);
});

test("the README documents the Node >= 20 prerequisite codex-connect.js itself enforces (docs-truth gate)", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /Node\s*>=\s*20/, "README must state the Node >= 20 prerequisite");
});

test("committed binary, unauthorized device: exits 0 and writes nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  runHookBinary(dataDir, "SessionStart", JSON.stringify(loadFixtureLine("SessionStart")));
  assert.ok(!existsSync(join(dataDir, "outbox")), "no config.json means fail closed: no outbox, no events");
});

test("committed binary, authorized + allowlisted: appends the SessionStart pair with the real captured payload", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  // Unreachable ingest (TEST-NET port 0): drain fails fast, appended events stay for inspection.
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  const stdin = loadFixtureLine("SessionStart");
  stdin.cwd = repo;
  runHookBinary(dataDir, "SessionStart", JSON.stringify(stdin));

  const files = readdirSync(join(dataDir, "outbox"));
  assert.equal(files.length, 2, "SessionStart appends the session event plus workspace.observed");
  const kinds = files
    .map((f) => (JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { kind: string }).kind)
    .sort();
  assert.deepEqual(kinds, ["SessionStart", "workspace.observed"]);
});

test("committed binary, PostToolUse: promotes a pending device config into PLUGIN_DATA and removes it", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  const codexHome = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-home-"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  // Seed the pending record the connect skill would have written (proven
  // separately, end to end through the real exchange(), in
  // codex-connect.test.ts) so this test isolates what's packaging-specific:
  // the COMMITTED dist codex-hook.js's own PostToolUse promotion step.
  writePendingConfig(codexHome, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  const pending = pendingConfigPath(codexHome);
  assert.ok(existsSync(pending));

  const stdin = loadFixtureLine("PostToolUse");
  stdin.cwd = repo;
  execFileSync("node", [hookBin, "PostToolUse"], {
    input: JSON.stringify(stdin),
    env: { ...process.env, PLUGIN_DATA: dataDir, CODEX_HOME: codexHome, TRINITY_BASE_URL: "http://127.0.0.1:1" },
  });

  assert.ok(!existsSync(pending), "the committed PostToolUse hook must promote and remove the pending file");
  const configPath = join(dataDir, "config.json");
  assert.ok(existsSync(configPath), "promotion must land PLUGIN_DATA/config.json");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});

test("the repo-root marketplace manifest names trinity-capture at the packaged codex plugin dir", () => {
  const manifestPath = join(process.cwd(), ".codex-plugin", "marketplace.json");
  assert.ok(existsSync(manifestPath), `${manifestPath} is missing — the plugin is not installable without it`);

  interface MarketplaceManifest {
    name: string;
    plugins: { name: string; source: string; version: string }[];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketplaceManifest;
  const entry = manifest.plugins.find((p) => p.name === "trinity-capture");
  assert.ok(entry, "marketplace.json lists no trinity-capture plugin");

  const sourceDir = resolve(process.cwd(), entry.source);
  assert.equal(sourceDir, resolve(process.cwd(), "codex"), `entry source ${entry.source} does not resolve to codex`);

  const plugin = JSON.parse(readFileSync(join(sourceDir, ".codex-plugin", "plugin.json"), "utf8")) as {
    name: string;
    version: string;
    skills?: string;
  };
  assert.equal(plugin.name, entry.name);
  assert.equal(plugin.version, entry.version, "marketplace entry and plugin.json disagree on the version");
  assert.equal(plugin.skills, "./skills/", "plugin.json must expose the packaged connect skill");
  assert.ok(existsSync(join(sourceDir, "dist", "codex-hook.js")), "the marketplace entry points at a dir without the committed build");
});

test("status before pairing reports that this installation is not paired", () => {
  const home = mkdtempSync(join(tmpdir(), "trinity-codex-unpaired-home-"));
  const output = execFileSync("node", [connectBin, "--status"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home },
  });
  assert.match(output, /not paired/i);
});

test("uninstall: hooks.json and the connect skill reference nothing outside the plugin dir — removing codex/ leaves no dangling refs", () => {
  const hooksPath = join(process.cwd(), "codex", "hooks", "hooks.json");
  const hooksRaw = readFileSync(hooksPath, "utf8");
  interface HooksManifest {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  }
  const hooks = JSON.parse(hooksRaw) as HooksManifest;

  const commands: string[] = [];
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) commands.push(h.command);
    }
  }
  assert.ok(commands.length > 0, "hooks.json registered no hooks");
  for (const command of commands) {
    assert.match(command, /\$\{PLUGIN_ROOT\}\/dist\//, `hook command must be rooted at \${PLUGIN_ROOT}, not an absolute path: ${command}`);
    assert.doesNotMatch(command, /\/Users\/|\/home\//, `hook command must not embed an absolute local path: ${command}`);
  }

  const skillPath = join(process.cwd(), "codex", "skills", "trinity-connect", "SKILL.md");
  const skillRaw = readFileSync(skillPath, "utf8");
  assert.match(skillRaw, /\$\{PLUGIN_ROOT\}\/dist\//, "the connect skill must invoke the plugin's own dist, not an external path");
  assert.doesNotMatch(skillRaw, /\/Users\/|\/home\//, "the connect skill must not embed an absolute local path");
});
