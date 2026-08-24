// The Cursor connect entrypoint: run manually from a terminal as
// `node cursor/dist/cursor-connect.js <pairing-code>` (Cursor's plugin
// commands have no proven equivalent of Claude Code's `!command` shell
// execution, so this ships as a plain CLI script rather than a speculative
// slash command — see README's Setup (Cursor) section). Reuses connect.ts's
// product-agnostic exchange() for the actual wire call; everything below is
// Cursor's own credential-home handling (spec finding 3): no CURSOR_PLUGIN_DATA
// equivalent exists, so the data directory is the secured per-user
// application-data location cursorDialect.dataDir resolves, created 0700
// with the credential file written 0600.
import { chmodSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cursorDialect } from "./cursor-hook.js";
import { exchange } from "./connect.js";
import { saveConfig } from "./config.js";

const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;

function nodeMajorVersion(): number {
  return Number(process.versions.node.split(".")[0]);
}

// Windows ACLs already scope %LOCALAPPDATA% to the current user by default;
// chmod has no POSIX-mode meaning there, so it is skipped rather than made
// to throw or no-op silently on a platform it was never meant for.
function securePosix(path: string, mode: number): void {
  if (platform() === "win32") return;
  chmodSync(path, mode);
}

// The testable half: exchange the code and write DeviceConfig under dataDir
// at 0700/0600. Exported so a test can drive it directly (a stubbed fetch,
// a temp dataDir) without spawning the CLI as a subprocess.
export async function connectCursor(baseUrl: string, code: string, dataDir: string): Promise<void> {
  const cfg = await exchange(baseUrl, code);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  securePosix(dataDir, 0o700);
  saveConfig(dataDir, cfg);
  securePosix(join(dataDir, "config.json"), 0o600);
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

  const dataDir = cursorDialect.dataDir(process.env);
  if (!dataDir) {
    console.error("Could not resolve a Trinity Capture data directory (set TRINITY_CAPTURE_DATA to override).");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
  const code = process.argv[2]?.trim() ?? "";
  if (code === "") {
    console.error("No pairing code provided. Usage: node cursor-connect.js <pairing-code>");
    process.exitCode = 1;
    return;
  }

  try {
    await connectCursor(baseUrl, code, dataDir);
    console.log("Trinity connected. This device now captures sessions for allowlisted repositories.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
