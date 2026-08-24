// The Codex CONNECT skill's entrypoint (spec's global constraints, finding 3):
// exchanges a pairing code and writes the resulting DeviceConfig to a PENDING
// file under $CODEX_HOME/trinity-capture/, mode 0600 — never directly into
// PLUGIN_DATA. C2.0 empirically proved a Codex plugin SKILL's shell command
// runs without PLUGIN_DATA (only hook COMMANDS get it), so this script cannot
// write the real device config itself. codex-hook.ts's PostToolUse handler
// promotes the pending record into PLUGIN_DATA atomically the next time a
// hook command runs, and removes the pending file. This script's own
// --status mode is the "read-back/status check" the skill uses to confirm
// that happened: it can never see PLUGIN_DATA either, so it reads the
// pending file's absence as the promotion signal instead.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exchange } from "./connect.js";
import type { DeviceConfig } from "./config.js";

const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;

function nodeMajorVersion(): number {
  return Number(process.versions.node.split(".")[0]);
}

// Exported so codex-hook.ts's promotion step and this suite's tests resolve
// the exact same home and pending path.
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function pendingConfigPath(home: string): string {
  return join(home, "trinity-capture", "pending-device.json");
}

// Atomic (temp+rename, same directory) and mode-0600. This directory is
// NOT PLUGIN_DATA — it's a plugin-managed corner of CODEX_HOME the skill can
// reach without that env var, secured the same way PLUGIN_DATA's own
// credential file is.
export function writePendingConfig(home: string, cfg: DeviceConfig): void {
  const dir = join(home, "trinity-capture");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is subject to umask; make the intent explicit
  const path = pendingConfigPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// Promotes a pending record into PLUGIN_DATA/config.json — the same file
// config.ts's loadConfig/saveConfig already read and write for every
// dialect — atomically (temp+rename) and mode-0600, then removes the
// pending file. No-op when nothing is pending. Malformed pending JSON (a
// half-written file, or none of the DeviceConfig fields) is left in place
// rather than promoted, for a later, complete write to replace.
//
// Exported for codex-hook.ts's PostToolUse handler and this suite's tests.
// Best-effort by contract: the caller is a hook, which must never surface a
// failure to the IDE, so every failure here is swallowed by the caller, not
// this function.
export function promotePendingConfig(home: string, pluginDataDir: string): void {
  const pending = pendingConfigPath(home);
  if (!existsSync(pending)) return;
  const cfg = JSON.parse(readFileSync(pending, "utf8")) as Partial<DeviceConfig>;
  if (!cfg.token || !cfg.ingestUrl || !cfg.deviceId) return;

  mkdirSync(pluginDataDir, { recursive: true });
  const dest = join(pluginDataDir, "config.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, dest);
  unlinkSync(pending);
}

async function main(): Promise<void> {
  if (nodeMajorVersion() < MIN_NODE_MAJOR) {
    console.error(
      `trinity-connect requires Node >= ${MIN_NODE_MAJOR} (found ${process.version}). ` +
        "Install a newer Node and re-run this command.",
    );
    process.exitCode = 1;
    return;
  }

  const home = codexHome(process.env);
  const arg = process.argv[2]?.trim() ?? "";

  if (arg === "--status") {
    if (existsSync(pendingConfigPath(home))) {
      console.log(
        "Trinity pairing recorded but not yet confirmed. Run any Codex tool call, then " +
          "run /trinity-connect --status again.",
      );
    } else {
      console.log("Trinity connected. This device now captures sessions for allowlisted repositories.");
    }
    return;
  }

  if (arg === "") {
    console.error("No pairing code provided. Usage: /trinity-connect <pairing-code>");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
  try {
    const cfg = await exchange(baseUrl, arg);
    writePendingConfig(home, cfg);
    console.log("Trinity pairing recorded. Run /trinity-connect --status next to confirm it landed.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
