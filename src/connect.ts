import { hostname } from "node:os";
import { loadConfig, saveConfig } from "./config.js";
import type { DeviceConfig } from "./config.js";
import { activationStatus, markPairedAwaitingNewSession } from "./activation.js";
import { isPolicyFresh } from "./gate.js";
import { isMainModule } from "./main-module.js";
import { refreshPolicy, REQUEST_TIMEOUT_MS } from "./send.js";

export const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;

export function supportsNodeVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}

export async function exchange(baseUrl: string, code: string, previousDeviceId: string | null): Promise<DeviceConfig> {
  const res = await fetch(`${baseUrl}/api/v1/devices/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      hostname: hostname(),
      ...(previousDeviceId ? { deviceId: previousDeviceId } : {}),
    }),
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
  if (!supportsNodeVersion(process.versions.node)) {
    console.error(`Trinity capture requires Node ${MIN_NODE_MAJOR} or newer; found ${process.version}.`);
    process.exitCode = 1;
    return;
  }
  const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? process.argv[3];
  if (!dataDir) {
    console.error("CLAUDE_PLUGIN_DATA is not set; cannot store credentials.");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
  const code = process.argv[2]?.trim() ?? "";
  const existingConfig = loadConfig(dataDir);
  const hasPairingCode = code !== "";

  try {
    let cfg: DeviceConfig;
    if (hasPairingCode) {
      cfg = await exchange(baseUrl, code, existingConfig?.deviceId ?? null);
      if (existingConfig && new URL(existingConfig.ingestUrl).origin !== new URL(cfg.ingestUrl).origin) {
        throw new Error("Existing Trinity connection kept. Use a separate plugin connection to test another environment.");
      }
      markPairedAwaitingNewSession(dataDir, cfg.deviceId);
      saveConfig(dataDir, cfg);
    } else {
      if (existingConfig === null) {
        console.error("No pairing code provided. Usage: /trinity:connect <pairing-code>");
        process.exitCode = 1;
        return;
      }
      cfg = existingConfig;
    }
    const policy = await refreshPolicy(dataDir, cfg);
    if (!isPolicyFresh(policy, Date.now())) {
      console.error("Trinity is paired, but capture policy could not be synced. Run /trinity:connect again to retry.");
      process.exitCode = 1;
      return;
    }
    const status = activationStatus(dataDir);
    if (status === "needs-repair") {
      console.error("Trinity connection needs repair. Generate a new pairing code and run /trinity:connect <pairing-code>.");
      process.exitCode = 1;
      return;
    }
    console.log(hasPairingCode
      ? `Trinity paired (${status}). Start a new Claude Code session in an enabled repository to begin capture.`
      : `Trinity status: ${status}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
