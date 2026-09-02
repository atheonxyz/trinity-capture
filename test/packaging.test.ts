// C2 acceptance: the COMMITTED plugin build at claude-code/dist/ — the exact
// files an installed plugin executes — runs under the CLAUDE_PLUGIN_DATA env
// contract with a real captured hook stdin. Not the dist-test compilation
// the other suites import; if the committed output is stale or missing,
// these fail.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";

// pnpm test always runs from the repository root.
const hookBin = join(process.cwd(), "claude-code", "dist", "claude-hook.js");
const dialectStdinPath = join(process.cwd(), "test", "testdata", "dialect-SessionStart.json");

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
  const dir = mkdtempSync(join(tmpdir(), "trinity-pkg-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

function runHookBinary(dataDir: string, eventName: string, stdin: string): void {
  // execFileSync throws on a non-zero exit — the hook contract is exit 0,
  // always.
  execFileSync("node", [hookBin, eventName], {
    input: stdin,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
}

test("the committed hook binary exists where hooks.json points", () => {
  assert.ok(existsSync(hookBin), `${hookBin} is missing — run pnpm build:plugin and commit the output`);
});

test("hook commands use the string form every host executes", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "claude-code", "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
  };
  for (const [eventName, groups] of Object.entries(manifest.hooks)) {
    const handler = groups[0]?.hooks[0];
    // The desktop app runs only the documented string command; a split
    // command+args pair degrades there to bare `node`, which swallows the
    // hook stdin as a script and captures nothing.
    assert.equal(handler?.command, `node "\${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js" ${eventName}`);
    assert.equal(handler?.args, undefined);
  }
});

test("committed binary, unauthorized device: exits 0 and writes nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-pkg-data-"));
  runHookBinary(dataDir, "SessionStart", readFileSync(dialectStdinPath, "utf8"));
  assert.ok(!existsSync(join(dataDir, "outbox")), "no config.json means fail closed: no outbox, no events");
});

test("committed binary, authorized + allowlisted: appends the SessionStart pair", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-pkg-data-"));
  // Unreachable ingest (TEST-NET port 0): drain fails fast, appended events
  // stay for inspection.
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  // The captured stdin verbatim, with only cwd retargeted at a repo that
  // exists on this machine.
  const stdin = JSON.parse(readFileSync(dialectStdinPath, "utf8")) as Record<string, unknown>;
  stdin.cwd = repo;
  runHookBinary(dataDir, "SessionStart", JSON.stringify(stdin));

  const files = readdirSync(join(dataDir, "outbox"));
  assert.equal(files.length, 2, "SessionStart appends the session event plus workspace.observed");
  const kinds = files
    .map((f) => (JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { kind: string }).kind)
    .sort();
  assert.deepEqual(kinds, ["SessionStart", "workspace.observed"]);
});

// A host keys one install's data directory per surface as
// "<plugin-name>-<source>", so these fixtures are named the way a real
// split install is — from the manifest, never a spelled-out product name.
const pluginName = (
  JSON.parse(readFileSync(join(process.cwd(), "claude-code", ".claude-plugin", "plugin.json"), "utf8")) as { name: string }
).name;

function splitInstall(surfaces: Record<string, string | null>): Record<string, string> {
  const parent = mkdtempSync(join(tmpdir(), "trinity-pkg-split-"));
  const dirs: Record<string, string> = {};
  for (const [surface, deviceId] of Object.entries(surfaces)) {
    const dir = join(parent, `${pluginName}-${surface}`);
    mkdirSync(dir, { recursive: true });
    dirs[surface] = dir;
    if (deviceId === null) continue;
    saveConfig(dir, { token: `tok-${deviceId}`, ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId });
    savePolicy(dir, {
      etag: "e1",
      fetchedAt: Date.now(),
      ttlSeconds: 900,
      captureLevel: "metadata",
      workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
    });
  }
  return dirs;
}

function runSessionStart(dataDir: string): void {
  const repo = initRepo("git@github.com:acme/widgets.git");
  const stdin = JSON.parse(readFileSync(dialectStdinPath, "utf8")) as Record<string, unknown>;
  stdin.cwd = repo;
  runHookBinary(dataDir, "SessionStart", JSON.stringify(stdin));
}

function outboxCount(dir: string): number {
  return existsSync(join(dir, "outbox")) ? readdirSync(join(dir, "outbox")).length : 0;
}

test("committed binary falls back to a paired sibling data directory", () => {
  // The desktop app and the CLI key the same install differently; a device
  // paired on one surface must capture on both.
  const dirs = splitInstall({ inline: null, marketplace: "dev1" });
  runSessionStart(dirs.inline);
  assert.equal(outboxCount(dirs.inline), 0, "the unpaired provided dir takes no writes");
  assert.equal(outboxCount(dirs.marketplace), 2, "events land in the paired sibling");
});

test("committed binary captures nowhere when paired siblings name different devices", () => {
  // The resolved directory supplies the token AND the allowlist policy, so
  // choosing between disagreeing siblings would file this session's prompts
  // under another account's device. "alpha" sorts first: a lexical pick
  // would send them there.
  const dirs = splitInstall({ inline: null, alpha: "dev-alpha", marketplace: "dev-main" });
  runSessionStart(dirs.inline);
  for (const [surface, dir] of Object.entries(dirs)) {
    assert.equal(outboxCount(dir), 0, `${surface} captured under an ambiguous pairing`);
  }
});

test("committed binary captures when paired siblings share one pairing", () => {
  // Two directory names for one device is not ambiguity: same token, same
  // policy, so the fallback stays usable.
  const dirs = splitInstall({ inline: null, alpha: "dev1", marketplace: "dev1" });
  runSessionStart(dirs.inline);
  assert.equal(outboxCount(dirs.inline), 0, "the unpaired provided dir takes no writes");
  assert.equal(outboxCount(dirs.alpha) + outboxCount(dirs.marketplace), 2, "one of the identical pairings takes the events");
});

test("committed binary omits the complete connect-command session from capture", () => {
  // Given: pairing has just created credentials and synced an allowlist in this Claude session.
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-pkg-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");
  const sessionId = "pairing-session";

  // When: Claude emits the command prompt and the lifecycle events that follow it.
  for (const [eventName, payload] of [
    ["UserPromptSubmit", { prompt: "/trinity:connect SECRET-FIXTURE" }],
    ["Stop", { last_assistant_message: "Trinity connected" }],
    ["SessionEnd", { reason: "other" }],
  ] as const) {
    runHookBinary(dataDir, eventName, JSON.stringify({ session_id: sessionId, hook_event_name: eventName, cwd: repo, ...payload }));
  }

  // Then: no credential or setup noise enters the durable outbox.
  const outboxDir = join(dataDir, "outbox");
  assert.deepEqual(existsSync(outboxDir) ? readdirSync(outboxDir) : [], []);
});

test("the public trinity-capture entry preserves the trinity command namespace", () => {
  // `/plugin marketplace add <repo>` reads .claude-plugin/marketplace.json at
  // the REPO root; the plugin's own manifest alone is not installable.
  const manifestPath = join(process.cwd(), ".claude-plugin", "marketplace.json");
  assert.ok(existsSync(manifestPath), `${manifestPath} is missing — the plugin is not installable without it`);

  interface MarketplaceManifest {
    name: string;
    plugins: { name: string; displayName: string; source: string; version: string }[];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketplaceManifest;
  const entry = manifest.plugins.find((p) => p.name === "trinity-capture");
  assert.ok(entry, "marketplace.json lists no trinity-capture plugin");

  const sourceDir = resolve(process.cwd(), entry.source);
  assert.equal(sourceDir, resolve(process.cwd(), "claude-code"), `entry source ${entry.source} does not resolve to claude-code`);

  // The entry must point at a real packaged plugin: its own manifest agrees
  // on the name, and the committed hook binary sits beneath it.
  const plugin = JSON.parse(readFileSync(join(sourceDir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string; displayName: string; version: string };
  assert.equal(plugin.name, "trinity");
  assert.equal(entry.displayName, "Trinity");
  assert.equal(plugin.displayName, entry.displayName);
  assert.equal(plugin.version, entry.version, "marketplace entry and plugin.json disagree on the version");
  assert.ok(existsSync(join(sourceDir, "dist", "claude-hook.js")), "the marketplace entry points at a dir without the committed build");
});

test("the connect command is manual-only and passes its pairing code and persistent data directory", () => {
  const command = readFileSync(join(process.cwd(), "claude-code", "commands", "connect.md"), "utf8");
  assert.match(command, /^argument-hint: \[pairing-code\]$/m);
  assert.match(command, /^arguments: \[pairing_code\]$/m);
  assert.match(command, /^disable-model-invocation: true$/m);
  assert.match(command, /dist\/connect\.js" "\$pairing_code" "\$\{CLAUDE_PLUGIN_DATA\}"/);
  assert.doesNotMatch(command, /\$ARGUMENTS|\$[0-9]/);
});
