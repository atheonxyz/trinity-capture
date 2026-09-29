import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import { answerJson, runMcpBinary, startDoor, toolsListResult } from "./helpers/mcp-door.js";

const pluginRoot = join(process.cwd(), "cursor");
const hookBin = join(pluginRoot, "dist", "cursor-hook.js");
const connectBin = join(pluginRoot, "dist", "cursor-connect.js");
const mcpBin = join(pluginRoot, "dist", "cursor-mcp.js");

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

test("cursor/dist never ships another product's entrypoint", () => {
  const files = readdirSync(join(pluginRoot, "dist"));
  assert.ok(!files.includes("claude-hook.js"), "cursor/dist must not ship claude-hook.js — it is not a real dependency of any cursor source file");
  assert.ok(!files.includes("claude-mcp.js") && !files.includes("codex-mcp.js"), "cursor/dist must ship only its own MCP entry");
});

test("claude-code/dist never ships the cursor entrypoints", () => {
  const files = readdirSync(join(process.cwd(), "claude-code", "dist"));
  assert.ok(!files.includes("cursor-hook.js"), "claude-code/dist must not ship cursor-hook.js");
  assert.ok(!files.includes("cursor-connect.js"), "claude-code/dist must not ship cursor-connect.js");
  assert.ok(!files.includes("cursor-mcp.js") && !files.includes("codex-mcp.js"), "claude-code/dist must ship only its own MCP entry");
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
    commands: string;
    logo: string;
    license: string;
  };
  assert.equal(pluginManifest.hooks, "hooks/hooks.json");
  assert.ok(existsSync(join(pluginRoot, pluginManifest.hooks)));
  assert.equal(pluginManifest.commands, "commands");
  assert.ok(existsSync(join(pluginRoot, pluginManifest.commands, "trinity-connect.md")));
  assert.equal(pluginManifest.license, "Apache-2.0");
  assert.ok(existsSync(join(pluginRoot, pluginManifest.logo)));
});

test("the connect command locates its installed plugin without relying on hook-only environment", () => {
  const command = readFileSync(join(pluginRoot, "commands", "trinity-connect.md"), "utf8");
  assert.doesNotMatch(command, /CURSOR_PLUGIN_ROOT/);
  assert.match(command, /\.cursor\/plugins/);
  assert.match(command, /\.cursor-plugin\/plugin\.json/);
  assert.match(command, /dist\/cursor-connect\.js/);
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

test("the plugin manifest names mcp.json, which declares the trinity server at the committed proxy with the plugin root passed through", () => {
  const pluginManifest = JSON.parse(readFileSync(join(pluginRoot, ".cursor-plugin", "plugin.json"), "utf8")) as { mcpServers: string };
  assert.equal(pluginManifest.mcpServers, "mcp.json");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, pluginManifest.mcpServers), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  };
  const server = manifest.mcpServers.trinity;
  assert.ok(server, "mcp.json declares no trinity server");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CURSOR_PLUGIN_ROOT}/dist/cursor-mcp.js"]);
  assert.deepEqual(server.env, { CURSOR_PLUGIN_ROOT: "${CURSOR_PLUGIN_ROOT}" }, "the data directory's channel is read from the plugin root");
  assert.ok(existsSync(mcpBin), `${mcpBin} is missing — run pnpm build:plugin-cursor and commit the output`);
});

test("the committed proxy reads the credential where the hooks keep it and prints no token", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "trinity-cursor-pkg-data-"));
    saveConfig(dataDir, { token: "secret-device-token", ingestUrl: door.ingestUrl, deviceId: "dev1", mcpUrl: door.mcpUrl });
    const run = await runMcpBinary(mcpBin, { ...process.env, CURSOR_PLUGIN_ROOT: pluginRoot, TRINITY_CAPTURE_DATA: dataDir }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.equal(run.exitCode, 0);
    assert.equal(run.stderr, "");
    assert.deepEqual(run.answers.find((answer) => answer.id === 2), toolsListResult(2, ["get_task"]));
    assert.equal(door.requests[0]?.authorization, "Bearer secret-device-token");
    assert.ok(!run.stdout.includes("secret-device-token"), "the token must reach the door alone");
  } finally {
    await door.close();
  }
});
