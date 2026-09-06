import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";
import { NativeCodexRpc } from "./codex-rpc.js";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"] as const;
const PLUGIN_ID_PREFIX = "trinity-capture@";

export type HookEventName = "sessionStart" | "userPromptSubmit" | "preToolUse" | "postToolUse" | "stop" | "sessionEnd";
export type HookTrustStatus = "managed" | "untrusted" | "trusted" | "modified";

export type HookMetadata = {
  readonly key: string;
  readonly eventName: HookEventName;
  readonly matcher: string | null;
  readonly sourcePath: string;
  readonly source: string;
  readonly pluginId: string | null;
  readonly enabled: boolean;
  readonly isManaged: boolean;
  readonly currentHash: string;
  readonly trustStatus: HookTrustStatus;
} & ({ readonly handlerType: "command"; readonly command: string; readonly async: boolean } | { readonly handlerType: "mcpTool" | "prompt" | "agent" });

export type HooksSnapshot = {
  readonly hooks: readonly HookMetadata[];
  readonly errors: readonly string[];
};

export interface CodexHookSetupRpc {
  hooksList(): Promise<HooksSnapshot>;
  configBatchWrite(params: ConfigBatchWriteParams): Promise<void>;
  close(): void;
}

type ExpectedHookRow = {
  readonly eventName: HookEventName;
  readonly eventKey: string;
  readonly matcher: string | null;
  readonly command: string;
};

type PublicHook = {
  readonly key: string;
  readonly eventName: HookEventName;
  readonly matcher: string | null;
  readonly currentHash: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly sourcePath: string;
  readonly trustStatus: HookTrustStatus;
};

export type ConfigBatchWriteParams = {
  readonly edits: readonly [
    {
      readonly keyPath: "hooks.state";
      readonly value: Record<string, { readonly trusted_hash: string }>;
      readonly mergeStrategy: "upsert";
    },
  ];
  readonly filePath: null;
  readonly expectedVersion: null;
  readonly reloadUserConfig: true;
};

type CheckResult =
  | { readonly status: "ready"; readonly pluginId: string; readonly hooks: readonly PublicHook[] }
  | {
      readonly status: "approval_required";
      readonly pluginId: string;
      readonly fingerprint: string;
      readonly hooks: readonly PublicHook[];
      readonly approvalRequiredHooks: readonly PublicHook[];
    }
  | { readonly status: "blocked"; readonly reason: string };

export function expectedHookRows(pluginRoot: string): readonly ExpectedHookRow[] {
  const commandByEvent = (eventName: (typeof HOOK_EVENTS)[number]): string =>
    `node "${pluginRoot}/dist/codex-hook.js" ${eventName}`;
  return [
    { eventName: "sessionStart", eventKey: "session_start", matcher: null, command: commandByEvent("SessionStart") },
    { eventName: "userPromptSubmit", eventKey: "user_prompt_submit", matcher: null, command: commandByEvent("UserPromptSubmit") },
    { eventName: "preToolUse", eventKey: "pre_tool_use", matcher: ".*", command: commandByEvent("PreToolUse") },
    { eventName: "postToolUse", eventKey: "post_tool_use", matcher: ".*", command: commandByEvent("PostToolUse") },
    { eventName: "stop", eventKey: "stop", matcher: null, command: commandByEvent("Stop") },
    { eventName: "sessionEnd", eventKey: "session_end", matcher: null, command: commandByEvent("SessionEnd") },
  ];
}

export async function checkHooks(rpc: CodexHookSetupRpc, pluginRoot = installedPluginRoot()): Promise<CheckResult> {
  const snapshot = await rpc.hooksList();
  return evaluateHooks(snapshot, pluginRoot);
}

export async function approveHooks(fingerprint: string, rpc: CodexHookSetupRpc, pluginRoot = installedPluginRoot()): Promise<CheckResult> {
  const before = await checkHooks(rpc, pluginRoot);
  if (before.status === "blocked" || before.status === "ready") return before;
  if (before.fingerprint !== fingerprint) return { status: "blocked", reason: "Refusing to approve stale fingerprint; rerun check and approve the current fingerprint." };

  const trustedHashes = Object.fromEntries(
    before.approvalRequiredHooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }] satisfies readonly [string, { readonly trusted_hash: string }]),
  );
  try {
    await rpc.configBatchWrite({
      edits: [{ keyPath: "hooks.state", value: trustedHashes, mergeStrategy: "upsert" }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    });
  } catch (error) {
    return { status: "blocked", reason: `Native Codex config write failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const after = await checkHooks(rpc, pluginRoot);
  if (after.status !== "ready") return { status: "blocked", reason: "Native Codex config write completed, but hooks did not become ready on reread." };
  if (after.pluginId !== before.pluginId || before.hooks.some((hook, index) =>
    hook.key !== after.hooks[index]?.key || hook.currentHash !== after.hooks[index]?.currentHash)) return { status: "blocked", reason: "Native Codex hook definitions changed after approval write; rerun check." };
  return after;
}

function evaluateHooks(snapshot: HooksSnapshot, pluginRoot: string): CheckResult {
  if (snapshot.errors.length > 0) return { status: "blocked", reason: `Native Codex returned hook errors: ${snapshot.errors.join("; ")}` };

  const expectedSourcePath = realpathSync(join(pluginRoot, "hooks", "hooks.json"));
  const hooks = snapshot.hooks.filter((hook) => sameRealPath(hook.sourcePath, expectedSourcePath));
  if (hooks.length !== HOOK_EVENTS.length) return { status: "blocked", reason: `Expected 6 Trinity hooks from ${expectedSourcePath}, found ${hooks.length}.` };

  const pluginIds = new Set(hooks.map((hook) => hook.pluginId));
  const [pluginId] = pluginIds;
  if (pluginIds.size !== 1 || typeof pluginId !== "string" || !pluginId.startsWith(PLUGIN_ID_PREFIX)) {
    return { status: "blocked", reason: "Trinity hook rows do not share a trinity-capture@... pluginId." };
  }

  const expected = expectedHookRows(pluginRoot);
  const byEvent = new Map(hooks.map((hook) => [hook.eventName, hook]));
  const publicHooks: PublicHook[] = [];
  for (const row of expected) {
    const hook = byEvent.get(row.eventName);
    if (!hook) return { status: "blocked", reason: `Missing Trinity hook for ${row.eventName}.` };
    const invalid = validateHook(hook, row, pluginId);
    if (invalid) return { status: "blocked", reason: invalid };
    publicHooks.push(publicHook(hook));
  }
  const approvalRequiredHooks = publicHooks.filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
  if (approvalRequiredHooks.length === 0) return { status: "ready", pluginId, hooks: publicHooks };

  return {
    status: "approval_required",
    pluginId,
    fingerprint: createHash("sha256").update(JSON.stringify({ pluginId, sourcePath: expectedSourcePath, hooks: publicHooks })).digest("hex"),
    hooks: publicHooks,
    approvalRequiredHooks,
  };
}

function validateHook(hook: HookMetadata, expected: ExpectedHookRow, pluginId: string): string | null {
  if (hook.key !== `${pluginId}:hooks/hooks.json:${expected.eventKey}:0:0`) return `Hook ${hook.key} has unexpected key for ${expected.eventName}.`;
  if (hook.source !== "plugin") return `Hook ${hook.key} has unexpected source ${hook.source}.`;
  if (hook.handlerType !== "command") return `Hook ${hook.key} is not a command hook.`;
  if (hook.command !== expected.command) return `Hook ${hook.key} has unexpected command.`;
  if (hook.matcher !== expected.matcher) return `Hook ${hook.key} has unexpected matcher.`;
  if (!hook.enabled) return `Hook ${hook.key} is disabled; enable the Trinity plugin hook in Codex before trusting it.`;
  if (hook.isManaged && hook.trustStatus !== "managed") return `Hook ${hook.key} has inconsistent managed hook state.`;
  if (hook.async) return `Hook ${hook.key} is unexpectedly async.`;
  return null;
}

function publicHook(hook: HookMetadata): PublicHook {
  if (hook.handlerType !== "command") throw new Error("internal error: non-command hook passed validation");
  return {
    key: hook.key,
    eventName: hook.eventName,
    matcher: hook.matcher,
    currentHash: hook.currentHash,
    command: hook.command,
    enabled: hook.enabled,
    sourcePath: hook.sourcePath,
    trustStatus: hook.trustStatus,
  };
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function installedPluginRoot(): string {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

function readString(value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error("expected string");
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  node dist/codex-hook-setup.js check [codex-executable]",
      "  node dist/codex-hook-setup.js approve <fingerprint> [codex-executable]",
      "",
      "check is read-only. If it returns approval_required, show the fingerprint to the human operator.",
      "approve writes trusted_hash values only after explicit human approval of that exact fingerprint.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "";
  const fingerprint = command === "approve" ? process.argv[3] : undefined;
  const codexPath = command === "approve" ? process.argv[4] ?? "codex" : process.argv[3] ?? "codex";
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command !== "check" && command !== "approve") {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (command === "approve" && !fingerprint) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let rpc: NativeCodexRpc | null = null;
  try {
    const pluginRoot = installedPluginRoot();
    rpc = await NativeCodexRpc.create(codexPath, realpathSync(join(pluginRoot, "hooks", "hooks.json")));
    const result = command === "check" ? await checkHooks(rpc, pluginRoot) : await approveHooks(readString(fingerprint), rpc, pluginRoot);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    rpc?.close();
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
