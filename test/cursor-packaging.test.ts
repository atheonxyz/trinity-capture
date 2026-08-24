// C2 acceptance's Cursor twin: the COMMITTED plugin build at cursor/dist/ —
// the exact files an installed plugin executes — runs under the
// CURSOR_PLUGIN_ROOT + TRINITY_CAPTURE_DATA env contract with a real
// captured hook stdin. Not the dist-test compilation the other suites
// import; if the committed output is stale or missing, these fail.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";

const pluginRoot = join(process.cwd(), "cursor");
const hookBin = join(pluginRoot, "dist", "cursor-hook.js");
const connectBin = join(pluginRoot, "dist", "cursor-connect.js");

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
  const dir = mkdtempSync(join(tmpdir(), "trinity-cursor-pkg-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

// Mirrors exactly what cursor/hooks/hooks.json's command line does:
// `node ${CURSOR_PLUGIN_ROOT}/dist/cursor-hook.js <event>`.
function runHookBinary(dataDir: string, event: string, stdin: string): void {
  execFileSync("node", [hookBin, event], {
    input: stdin,
    env: { ...process.env, CURSOR_PLUGIN_ROOT: pluginRoot, TRINITY_CAPTURE_DATA: dataDir },
  });
}

test("the committed hook and connect binaries exist where hooks.json / the README point", () => {
  assert.ok(existsSync(hookBin), `${hookBin} is missing — run pnpm build:plugin-cursor and commit the output`);
  assert.ok(existsSync(connectBin), `${connectBin} is missing — run pnpm build:plugin-cursor and commit the output`);
});

// Regression guard for a real bug: tsconfig.plugin-cursor.json and
// tsconfig.plugin.json once both used a whole-tree "src/**/*.ts" include,
// so building either product's dist pulled in every product's entrypoint —
// cursor/dist shipped claude-hook.js, claude-code/dist shipped
// cursor-hook.js/cursor-connect.js. Each tsconfig now lists its own
// product's entrypoint explicitly; connect.js legitimately stays in
// cursor/dist because cursor-connect.ts genuinely imports its exchange().
test("cursor/dist never ships another product's entrypoint", () => {
  const files = readdirSync(join(pluginRoot, "dist"));
  assert.ok(!files.includes("claude-hook.js"), "cursor/dist must not ship claude-hook.js — it is not a real dependency of any cursor source file");
});

test("claude-code/dist never ships the cursor entrypoints", () => {
  const files = readdirSync(join(process.cwd(), "claude-code", "dist"));
  assert.ok(!files.includes("cursor-hook.js"), "claude-code/dist must not ship cursor-hook.js");
  assert.ok(!files.includes("cursor-connect.js"), "claude-code/dist must not ship cursor-connect.js");
});

test("committed binary, unauthorized device: exits 0 and writes nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-cursor-pkg-data-"));
  const stdin = JSON.stringify({ hook_event_name: "sessionStart", conversation_id: "s1", generation_id: "g1", model: "default", workspace_roots: ["/workspace/acme"] });
  runHookBinary(dataDir, "sessionStart", stdin);
  assert.ok(!existsSync(join(dataDir, "outbox")), "no config.json means fail closed: no outbox, no events");
});

test("committed binary, authorized + allowlisted: appends the sessionStart pair", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-cursor-pkg-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  const stdin = JSON.stringify({
    hook_event_name: "sessionStart",
    conversation_id: "s1",
    generation_id: "g1",
    model: "default",
    workspace_roots: [repo],
    user_email: "redacted-user",
  });
  runHookBinary(dataDir, "sessionStart", stdin);

  const files = readdirSync(join(dataDir, "outbox"));
  assert.equal(files.length, 2, "sessionStart appends the session event plus workspace.observed");
  const kinds = files
    .map((f) => (JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { kind: string }).kind)
    .sort();
  assert.deepEqual(kinds, ["sessionStart", "workspace.observed"]);
});

test("committed binary: a multi-root event is dropped and recorded through the real subprocess, not just the in-process helper", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-cursor-pkg-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  const stdin = JSON.stringify({
    hook_event_name: "postToolUse",
    conversation_id: "s1",
    generation_id: "g1",
    tool_name: "Read",
    tool_use_id: "tu1",
    workspace_roots: [repo, "/workspace/some-other-repo"],
  });
  runHookBinary(dataDir, "postToolUse", stdin);

  assert.ok(!existsSync(join(dataDir, "outbox")), "a multi-root event must never reach the outbox");
  const status = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8")) as { drops: { reason: string }[] };
  assert.equal(status.drops.length, 1);
  assert.equal(status.drops[0].reason, "multi_root");
});

test("cursor/.cursor-plugin/plugin.json names its hooks manifest and the committed hooks/hooks.json exists", () => {
  const pluginManifest = JSON.parse(readFileSync(join(pluginRoot, ".cursor-plugin", "plugin.json"), "utf8")) as {
    name: string;
    version: string;
    hooks: string;
  };
  assert.equal(pluginManifest.hooks, "hooks/hooks.json");
  assert.ok(existsSync(join(pluginRoot, pluginManifest.hooks)));
});

test("the repo-root .cursor-plugin/marketplace.json names trinity-capture at the packaged cursor plugin dir", () => {
  const manifestPath = join(process.cwd(), ".cursor-plugin", "marketplace.json");
  assert.ok(existsSync(manifestPath), `${manifestPath} is missing — the plugin is not installable without it`);

  interface MarketplaceManifest {
    name: string;
    plugins: { name: string; source: string; version: string }[];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketplaceManifest;
  const entry = manifest.plugins.find((p) => p.name === "trinity-capture");
  assert.ok(entry, "marketplace.json lists no trinity-capture plugin");

  const sourceDir = resolve(process.cwd(), entry.source);
  assert.equal(sourceDir, resolve(process.cwd(), "cursor"), `entry source ${entry.source} does not resolve to cursor`);

  const plugin = JSON.parse(readFileSync(join(sourceDir, ".cursor-plugin", "plugin.json"), "utf8")) as { name: string; version: string };
  assert.equal(plugin.name, entry.name);
  assert.equal(plugin.version, entry.version, "marketplace entry and plugin.json disagree on the version");
  assert.ok(existsSync(join(sourceDir, "dist", "cursor-hook.js")), "the marketplace entry points at a dir without the committed build");
});
