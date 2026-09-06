import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkHooks,
  approveHooks,
  expectedHookRows,
  type CodexHookSetupRpc,
  type HookMetadata,
} from "../src/codex-hook-setup.js";

const pluginId = "trinity-capture@openai-curated-remote";
const pluginRoot = realpathSync(join(process.cwd(), "codex"));

type MutableHook = HookMetadata & { trustStatus: HookMetadata["trustStatus"]; enabled: boolean };

class FakeRpc implements CodexHookSetupRpc {
  readonly writes: unknown[] = [];
  hooks: readonly HookMetadata[];
  readonly writeFails: boolean;

  constructor(hooks: readonly HookMetadata[], writeFails = false) {
    this.hooks = hooks;
    this.writeFails = writeFails;
  }

  async hooksList(): Promise<{ readonly hooks: readonly HookMetadata[]; readonly errors: readonly string[] }> {
    return { hooks: this.hooks, errors: [] };
  }

  async configBatchWrite(params: unknown): Promise<void> {
    this.writes.push(params);
    if (this.writeFails) throw new Error("write failed");
    this.hooks = this.hooks.map((hook) =>
      hook.trustStatus === "untrusted" || hook.trustStatus === "modified"
        ? { ...hook, trustStatus: "trusted" }
        : hook,
    );
  }

  close(): void {}
}

function trinityHooks(overrides: Partial<MutableHook> = {}): readonly HookMetadata[] {
  return trinityHooksForRoot(pluginRoot, overrides);
}

function trinityHooksForRoot(root: string, overrides: Partial<MutableHook> = {}): readonly HookMetadata[] {
  const rootSourcePath = realpathSync(join(root, "hooks", "hooks.json"));
  return expectedHookRows(root).map((row, index) => ({
    key: `${pluginId}:hooks/hooks.json:${row.eventKey}:0:0`,
    eventName: row.eventName,
    matcher: row.matcher,
    sourcePath: rootSourcePath,
    source: "plugin",
    pluginId,
    enabled: true,
    isManaged: false,
    currentHash: `hash-${index + 1}`,
    trustStatus: "trusted",
    handlerType: "command",
    command: row.command,
    async: false,
    ...overrides,
  }));
}

test("check reports ready without writing when all six hooks are trusted", async () => {
  const rpc = new FakeRpc(trinityHooks());

  const result = await checkHooks(rpc, pluginRoot);

  assert.equal(result.status, "ready");
  assert.equal(result.hooks.length, 6);
  assert.deepEqual(rpc.writes, []);
});

test("check reports approval_required with a fingerprint for untrusted or modified hooks", async () => {
  const hooks = trinityHooks().map((hook, index): HookMetadata => {
    if (index === 0) return { ...hook, trustStatus: "untrusted" };
    if (index === 1) return { ...hook, trustStatus: "modified" };
    return hook;
  });
  const rpc = new FakeRpc(hooks);

  const result = await checkHooks(rpc, pluginRoot);

  assert.equal(result.status, "approval_required");
  assert.equal(result.hooks.length, 6);
  assert.equal(result.approvalRequiredHooks.length, 2);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(rpc.writes, []);
});

test("check blocks when the plugin does not expose exactly the expected six hooks", async () => {
  const rpc = new FakeRpc(trinityHooks().slice(0, 5));

  const result = await checkHooks(rpc, pluginRoot);

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /Expected 6 Trinity hooks/);
  assert.deepEqual(rpc.writes, []);
});

test("check rejects foreign plugin, command, source, source path, disabled, and inconsistent managed hook rows", async () => {
  const cases: readonly [string, Partial<MutableHook>, RegExp][] = [
    ["plugin", { pluginId: "other@openai" }, /pluginId/],
    ["key", { key: "trinity-capture@openai-curated-remote:hooks/hooks.json:session_start:9:9" }, /key/],
    ["command", { command: "node /tmp/evil.js SessionStart" }, /command/],
    ["source", { source: "user" }, /source/],
    ["sourcePath", { sourcePath: realpathSync(process.cwd()) }, /Expected 6/],
    ["disabled", { enabled: false }, /disabled/],
    ["managed", { isManaged: true }, /managed/],
  ];

  for (const [name, override, reason] of cases) {
    await test(`rejects ${name}`, async () => {
      const rpc = new FakeRpc(trinityHooks(override));

      const result = await checkHooks(rpc, pluginRoot);

      assert.equal(result.status, "blocked");
      assert.match(result.reason, reason);
      assert.deepEqual(rpc.writes, []);
    });
  }
});

test("check treats enabled managed hooks as ready and never writes them", async () => {
  const rpc = new FakeRpc(trinityHooks({ isManaged: true, trustStatus: "managed" }));

  const result = await checkHooks(rpc, pluginRoot);

  assert.equal(result.status, "ready");
  assert.deepEqual(rpc.writes, []);
});

test("approve re-reads hooks and rejects a stale fingerprint before writing", async () => {
  const hooks = trinityHooks({ trustStatus: "untrusted" });
  const initial = await checkHooks(new FakeRpc(hooks), pluginRoot);
  assert.equal(initial.status, "approval_required");
  const changed = hooks.map((hook, index) => (index === 0 ? { ...hook, currentHash: "new-hash" } : hook));
  const rpc = new FakeRpc(changed);

  const result = await approveHooks(initial.fingerprint, rpc, pluginRoot);

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /stale fingerprint/);
  assert.deepEqual(rpc.writes, []);
});

test("approve writes only trusted_hash values for hooks requiring approval and then requires ready", async () => {
  const hooks = trinityHooks().map((hook, index): HookMetadata => {
    if (index === 0) return { ...hook, trustStatus: "untrusted" };
    if (index === 1) return { ...hook, trustStatus: "modified" };
    return hook;
  });
  const rpc = new FakeRpc(hooks);
  const check = await checkHooks(rpc, pluginRoot);
  assert.equal(check.status, "approval_required");

  const result = await approveHooks(check.fingerprint, rpc, pluginRoot);

  assert.equal(result.status, "ready");
  assert.equal(rpc.writes.length, 1);
  assert.deepEqual(rpc.writes[0], {
    edits: [
      {
        keyPath: "hooks.state",
        value: {
          "trinity-capture@openai-curated-remote:hooks/hooks.json:session_start:0:0": { trusted_hash: "hash-1" },
          "trinity-capture@openai-curated-remote:hooks/hooks.json:user_prompt_submit:0:0": { trusted_hash: "hash-2" },
        },
        mergeStrategy: "upsert",
      },
    ],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
});

test("approve refuses readiness when the native hook hash changes after the write", async () => {
  class ChangedAfterWrite extends FakeRpc {
    override async configBatchWrite(params: unknown): Promise<void> {
      await super.configBatchWrite(params);
      this.hooks = this.hooks.map((hook, index) => index === 0 ? { ...hook, currentHash: "changed-native-hash" } : hook);
    }
  }
  const rpc = new ChangedAfterWrite(trinityHooks({ trustStatus: "untrusted" }));
  const check = await checkHooks(rpc, pluginRoot);
  assert.equal(check.status, "approval_required");

  const result = await approveHooks(check.fingerprint, rpc, pluginRoot);

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /changed after approval/);
});

test("approve reports blocked when the native config write fails", async () => {
  const hooks = trinityHooks({ trustStatus: "untrusted" });
  const check = await checkHooks(new FakeRpc(hooks), pluginRoot);
  assert.equal(check.status, "approval_required");
  const rpc = new FakeRpc(hooks, true);

  const result = await approveHooks(check.fingerprint, rpc, pluginRoot);

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /write failed/);
});

test("CLI check uses the fake app-server process and never writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "trinity-codex-hook-setup-"));
  const statePath = join(dir, "state.json");
  const fakeCodex = join(dir, "codex.js");
  const cliRoot = realpathSync(join(process.cwd(), "dist-test"));
  mkdirSync(join(cliRoot, "hooks"), { recursive: true });
  writeFileSync(join(cliRoot, "hooks", "hooks.json"), "{}");
  writeFileSync(
    statePath,
    JSON.stringify({
      hooks: [
        ...trinityHooksForRoot(cliRoot, { trustStatus: "untrusted" }),
        {
          key: "omo@sisyphuslabs:hooks/post-compact.json:post_compact:0:0",
          eventName: "postCompact",
          handlerType: "prompt",
          matcher: null,
                            sourcePath: process.cwd(),
          source: "plugin",
          pluginId: "omo@sisyphuslabs",
          displayOrder: 99,
          enabled: true,
          isManaged: false,
          currentHash: "sha256:unrelated",
          trustStatus: "trusted",
        },
      ],
      writes: [],
    }),
  );
  writeFileSync(fakeCodex, `#!${process.execPath}\n${fakeAppServerSource(statePath)}`);
  chmodSync(fakeCodex, 0o755);

  const output = execFileSync(process.execPath, ["dist-test/src/codex-hook-setup.js", "check", fakeCodex], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const result = JSON.parse(output) as { readonly status: string; readonly fingerprint: string };
  const state = JSON.parse(execFileSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(statePath)}).writes.length.toString())`], { encoding: "utf8" }));

  assert.equal(result.status, "approval_required");
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(state, 0);
});

test("CLI reports timeout from a hung native app-server", () => {
  const dir = mkdtempSync(join(tmpdir(), "trinity-codex-hook-setup-"));
  const fakeCodex = join(dir, "codex.js");
  writeFileSync(fakeCodex, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(fakeCodex, 0o755);

  assert.throws(
    () =>
      execFileSync(process.execPath, ["dist-test/src/codex-hook-setup.js", "check", fakeCodex], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /native Codex RPC timed out/,
  );
});

test("CLI --help exits without opening native RPC", () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["dist-test/src/codex-hook-setup.js", "--help", "/missing/codex"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
});

test("CLI approve without fingerprint fails before opening native RPC", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ["dist-test/src/codex-hook-setup.js", "approve"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /Usage:/,
  );
});

function fakeAppServerSource(statePathValue: string): string {
  return `
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePathValue)};
process.stdin.setEncoding("utf8");
let buffer = "";
function send(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\\n");
    if (at === -1) return;
    const raw = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (msg.method === "initialize") {
      send(msg.id, { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" });
      process.stdout.write(JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } }) + "\\n");
    }
    else if (msg.method === "hooks/list") send(msg.id, { data: [{ cwd: process.cwd(), hooks: state.hooks, warnings: [], errors: [] }] });
    else if (msg.method === "config/batchWrite") {
      state.writes.push(msg.params);
      state.hooks = state.hooks.map((hook) => ({ ...hook, trustStatus: "trusted" }));
      fs.writeFileSync(statePath, JSON.stringify(state));
      send(msg.id, { status: "ok", version: "v2", filePath: "/tmp/config.toml", overriddenMetadata: null });
    }
  }
});
`;
}
