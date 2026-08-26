import { chmodSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cursorDialect } from "./cursor-hook.js";
import { exchange } from "./connect.js";
import { saveConfig } from "./config.js";
import { isPolicyFresh } from "./gate.js";
import { refreshPolicy } from "./send.js";

const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;

function securePosixMode(path: string, mode: number): void {
  if (platform() === "win32") return;
  chmodSync(path, mode);
}

export async function connectCursor(baseUrl: string, code: string, dataDir: string): Promise<void> {
  const cfg = await exchange(baseUrl, code);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  securePosixMode(dataDir, 0o700);
  saveConfig(dataDir, cfg);
  securePosixMode(join(dataDir, "config.json"), 0o600);
  const policy = await refreshPolicy(dataDir, cfg);
  if (!isPolicyFresh(policy, Date.now())) {
    throw new Error("Trinity paired the device, but capture policy could not be synced. Run the connect command again.");
  }
}

async function main(): Promise<void> {
  const nodeMajorVersion = Number(process.versions.node.split(".")[0]);
  if (nodeMajorVersion < MIN_NODE_MAJOR) {
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
