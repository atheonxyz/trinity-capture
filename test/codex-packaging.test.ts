// C2 acceptance: the COMMITTED plugin build at codex/dist/ — the exact files
// an installed plugin executes — runs under the PLUGIN_DATA/CODEX_HOME env
// contract with a real captured hook stdin. Not the dist-test compilation
// the other suites import; if the committed output is stale or missing,
// these fail. Mirrors test/packaging.test.ts's own acceptance for claude-code/dist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig, savePolicy } from "../src/config.js";
import { writePendingConfig, pendingConfigPath, targetKey, targetKeyForPluginData } from "../src/codex-connect.js";
import { codexDataDirFromInstall } from "../src/codex-mcp.js";
import { activationStatus } from "../src/activation.js";
import { answerJson, runMcpBinary, startDoor, toolsListResult } from "./helpers/mcp-door.js";

// pnpm test always runs from the repository root.
const hookBin = join(process.cwd(), "codex", "dist", "codex-hook.js");
const mcpBin = join(process.cwd(), "codex", "dist", "codex-mcp.js");
const connectBin = join(process.cwd(), "codex", "dist", "codex-connect.js");
const setupBin = join(process.cwd(), "codex", "dist", "codex-hook-setup.js");
const fixturePath = join(process.cwd(), "test", "testdata", "codex_session.jsonl");

async function withPolicyServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ etag: "e1", ttlSeconds: 900, captureLevel: "metadata", workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function runHookProcess(event: string, stdin: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [hookBin, event], { env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(JSON.stringify(stdin));
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
}

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
  assert.ok(existsSync(setupBin), "the setup skill needs its packaged hook approval helper");
  execFileSync("node", [setupBin, "--help"], { timeout: 5_000 });
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

test("committed binary, PostToolUse: promotes a pending device config but suppresses the setup session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  const codexHome = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-home-"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  // Seed the pending record the connect skill would have written (proven
  // separately, end to end through the real exchange(), in
  // codex-connect.test.ts) so this test isolates what's packaging-specific:
  // the COMMITTED dist codex-hook.js's own PostToolUse promotion step.
  const key = targetKeyForPluginData(dataDir);
  const pending = pendingConfigPath(codexHome, key);

  const stdin = loadFixtureLine("PostToolUse");
  stdin.cwd = repo;
  await withPolicyServer(async (baseUrl) => {
    writePendingConfig(codexHome, { token: "tok", ingestUrl: `${baseUrl}/api/v1/ingest/batches`, deviceId: "dev1" }, key);
    assert.ok(existsSync(pending));
    await runHookProcess("PostToolUse", stdin, {
      ...process.env, PLUGIN_DATA: dataDir, CODEX_HOME: codexHome, TRINITY_BASE_URL: baseUrl,
    });
  });

  assert.ok(!existsSync(pending), "the committed PostToolUse hook must promote and remove the pending file");
  const configPath = join(dataDir, "config.json");
  assert.ok(existsSync(configPath), "promotion must land PLUGIN_DATA/config.json");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(activationStatus(dataDir), "paired-awaiting-new-session");
  assert.ok(!existsSync(join(dataDir, "outbox")), "the setup tool event must not be captured after promotion");
});

test("committed binary, pending device can promote and capture on the first new SessionStart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  const codexHome = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-home-"));
  const repo = initRepo("git@github.com:acme/widgets.git");
  const stdin = loadFixtureLine("SessionStart");
  stdin.cwd = repo;
  await withPolicyServer(async (baseUrl) => {
    writePendingConfig(codexHome, { token: "tok", ingestUrl: `${baseUrl}/api/v1/ingest/batches`, deviceId: "dev1" }, targetKeyForPluginData(dataDir));
    await runHookProcess("SessionStart", stdin, {
      ...process.env, PLUGIN_DATA: dataDir, CODEX_HOME: codexHome, TRINITY_BASE_URL: baseUrl,
    });
  });

  assert.ok(!existsSync(pendingConfigPath(codexHome, targetKeyForPluginData(dataDir))));
  assert.equal(activationStatus(dataDir), "ready");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 2);
});

test("the repo-root marketplace manifest names trinity-capture at the packaged codex plugin dir", () => {
  const manifestPath = join(process.cwd(), ".agents", "plugins", "marketplace.json");
  assert.ok(existsSync(manifestPath), `${manifestPath} is missing — the plugin is not installable without it`);

  interface MarketplaceManifest {
    name: string;
    plugins: {
      name: string;
      source: { source: string; path: string };
      policy: { installation: string; authentication: string };
      category: string;
    }[];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketplaceManifest;
  const entry = manifest.plugins.find((p) => p.name === "trinity-capture");
  assert.ok(entry, "marketplace.json lists no trinity-capture plugin");

  assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
  assert.equal(entry.category, "Productivity");

  const sourceDir = resolve(process.cwd(), entry.source.path);
  assert.equal(entry.source.source, "local");
  assert.equal(sourceDir, resolve(process.cwd(), "codex"), `entry source ${entry.source.path} does not resolve to codex`);

  const plugin = JSON.parse(readFileSync(join(sourceDir, ".codex-plugin", "plugin.json"), "utf8")) as {
    name: string;
    skills?: string;
    hooks?: unknown;
    interface?: { displayName?: string };
  };
  assert.equal(plugin.name, entry.name);
  assert.equal(plugin.skills, "./skills/", "plugin.json must expose the packaged connect skill");
  assert.equal(plugin.hooks, undefined, "Codex discovers the default hooks/hooks.json without a manifest override");
  assert.equal(plugin.interface?.displayName, "Trinity");
  assert.ok(existsSync(join(sourceDir, "dist", "codex-hook.js")), "the marketplace entry points at a dir without the committed build");
});

test("the Codex package exposes public-directory metadata and assets", () => {
  const packageManifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    readonly version: string;
  };
  const pluginManifest = JSON.parse(readFileSync(join(process.cwd(), "codex", ".codex-plugin", "plugin.json"), "utf8")) as {
    readonly version: string;
    readonly author: { readonly email?: string; readonly url?: string };
    readonly homepage?: string;
    readonly repository?: string;
    readonly license?: string;
    readonly interface?: {
      readonly websiteURL?: string;
      readonly privacyPolicyURL?: string;
      readonly termsOfServiceURL?: string;
      readonly defaultPrompt?: readonly string[];
      readonly logo?: string;
      readonly composerIcon?: string;
      readonly screenshots?: unknown;
    };
  };

  assert.equal(pluginManifest.version, packageManifest.version);
  assert.equal(pluginManifest.author.email, "hi@usetrinity.ai");
  assert.equal(pluginManifest.author.url, "https://usetrinity.ai");
  assert.equal(pluginManifest.homepage, "https://usetrinity.ai");
  assert.equal(pluginManifest.repository, "https://github.com/atheonxyz/trinity-capture");
  assert.equal(pluginManifest.license, "Apache-2.0");
  assert.equal(pluginManifest.interface?.websiteURL, "https://usetrinity.ai");
  assert.equal(pluginManifest.interface?.privacyPolicyURL, "https://usetrinity.ai/privacy");
  assert.equal(pluginManifest.interface?.termsOfServiceURL, "https://usetrinity.ai/terms");
  assert.ok(Array.isArray(pluginManifest.interface?.defaultPrompt));
  assert.ok(pluginManifest.interface?.defaultPrompt?.length);
  assert.ok(pluginManifest.interface?.logo);
  assert.ok(existsSync(resolve(process.cwd(), "codex", pluginManifest.interface?.logo ?? "")));
  assert.ok(pluginManifest.interface?.composerIcon);
  assert.ok(existsSync(resolve(process.cwd(), "codex", pluginManifest.interface?.composerIcon ?? "")));
  assert.equal(pluginManifest.interface?.screenshots, undefined);
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
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  }
  const hooks = JSON.parse(hooksRaw) as HooksManifest;

  const commands: string[] = [];
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) {
      const matcher = entry.matcher;
      if (matcher) assert.doesNotThrow(() => new RegExp(matcher), `invalid hook matcher: ${matcher}`);
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
  assert.match(skillRaw, /dist\/codex-connect\.js/);
  assert.match(skillRaw, /dist\/codex-hook-setup\.js/);
  assert.doesNotMatch(skillRaw, /codex-connect\.js" <pairing-code> trinity-capture@trinity/);
  assert.doesNotMatch(skillRaw, /\/Users\/|\/home\//, "the connect skill must not embed an absolute local path");
});

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list" };

test(".mcp.json declares the trinity server relative to the plugin root, with no variable Codex would leave unexpanded", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "codex", ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; cwd?: string; default_tools_approval_mode?: string }>;
  };
  const server = manifest.mcpServers.trinity;
  assert.ok(server, ".mcp.json declares no trinity server");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["dist/codex-mcp.js"]);
  assert.equal(server.cwd, ".", "only a relative cwd resolves against the plugin root");
  assert.equal(server.default_tools_approval_mode, "approve", "codex exec refuses a tool call that would need approval");
  assert.ok(existsSync(resolve(process.cwd(), "codex", server.cwd, server.args[0])), "the declared entry must be the committed build");
  for (const value of [server.command, ...server.args]) assert.doesNotMatch(value, /\$\{|\/Users\/|\/home\//, `Codex substitutes nothing in .mcp.json: ${value}`);
});

test("the proxy derives Codex's data directory from its own install path, under the key the connect skill writes", () => {
  const home = join(tmpdir(), "codex-home");
  const derived = codexDataDirFromInstall(join(home, "plugins", "cache", "trinity", "trinity-capture", "0.3.13", "dist", "codex-mcp.js"));
  assert.equal(derived, join(home, "plugins", "data", "trinity-capture-trinity"));
  assert.equal(targetKeyForPluginData(derived ?? ""), targetKey("trinity-capture@trinity"), "the pending file the skill writes is the one the proxy promotes");
  assert.equal(codexDataDirFromInstall(mcpBin), null, "a checkout is not an install");
  assert.equal(codexDataDirFromInstall(join(home, "plugins", "elsewhere", "trinity", "trinity-capture", "0.3.13", "dist", "codex-mcp.js")), null);
  assert.equal(codexDataDirFromInstall(join(home, "plugins", "cache", "trinity", "trinity-capture", "0.3.13", "codex-mcp.js")), null);
});

test("the committed proxy promotes a pending pairing before its first read, then lists the door's tools with the promoted token", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-data-"));
  const codexHome = mkdtempSync(join(tmpdir(), "trinity-codex-pkg-home-"));
  const key = targetKeyForPluginData(dataDir);
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  try {
    writePendingConfig(codexHome, { token: "secret-device-token", ingestUrl: door.ingestUrl, deviceId: "dev1", mcpUrl: door.mcpUrl }, key);
    const run = await runMcpBinary(mcpBin, { ...process.env, TRINITY_CAPTURE_DATA: dataDir, CODEX_HOME: codexHome, TRINITY_BASE_URL: door.origin }, [initialize, listTools]);
    assert.equal(run.exitCode, 0);
    assert.equal(run.stderr, "");
    assert.ok(!existsSync(pendingConfigPath(codexHome, key)), "the proxy must run the hooks' promotion before reading the config");
    assert.equal(loadConfig(dataDir)?.mcpUrl, door.mcpUrl, "the promoted config keeps the tools address the exchange answered");
    assert.equal(activationStatus(dataDir), "paired-awaiting-new-session");
    assert.deepEqual(run.answers.find((answer) => answer.id === 2), toolsListResult(2, ["get_task"]));
    assert.equal(door.requests[0]?.authorization, "Bearer secret-device-token");
    assert.ok(!run.stdout.includes("secret-device-token"), "the token must reach the door alone");
  } finally {
    await door.close();
  }
});
