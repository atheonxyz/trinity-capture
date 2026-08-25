import { pathToFileURL } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import type { DeviceConfig } from "./config.js";
import { isPolicyFresh } from "./gate.js";
import { refreshPolicy, REQUEST_TIMEOUT_MS } from "./send.js";

const DEFAULT_BASE_URL = "https://api.usetrinity.ai";

export async function exchange(baseUrl: string, code: string): Promise<DeviceConfig> {
  const res = await fetch(`${baseUrl}/api/v1/devices/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "That pairing code was not recognized or has expired."
        : `Exchange failed: ${res.status}`,
    );
  }
  const body = (await res.json()) as { token: string; deviceId: string; ingestUrl: string };
  return { token: body.token, ingestUrl: body.ingestUrl, deviceId: body.deviceId };
}

async function main(): Promise<void> {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? process.argv[3];
  if (!dataDir) {
    console.error("CLAUDE_PLUGIN_DATA is not set; cannot store credentials.");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
  const code = process.argv[2]?.trim() ?? "";
  const existingConfig = loadConfig(dataDir);
  const refreshingExistingDevice = code === "";

  try {
    let cfg: DeviceConfig;
    if (refreshingExistingDevice) {
      if (existingConfig === null) {
        console.error("No pairing code provided. Usage: /trinity:connect <pairing-code>");
        process.exitCode = 1;
        return;
      }
      cfg = existingConfig;
    } else {
      cfg = await exchange(baseUrl, code);
      saveConfig(dataDir, cfg);
    }
    const policy = await refreshPolicy(dataDir, cfg);
    if (!isPolicyFresh(policy, Date.now())) {
      console.error("Trinity is paired, but capture policy could not be synced. Run /trinity:connect again to retry.");
      process.exitCode = 1;
      return;
    }
    console.log(refreshingExistingDevice ? "Trinity capture policy refreshed." : "Trinity connected. Exit Claude Code and start a new session in an enabled repository to begin capture.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
