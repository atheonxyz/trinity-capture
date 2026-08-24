// The `/trinity-connect` command: prompts for a pairing code, calls
// POST /devices/exchange, writes the resulting DeviceConfig (spec §4.1).
import { createInterface } from "node:readline/promises";
import { saveConfig } from "./config.js";
import type { DeviceConfig } from "./config.js";

const DEFAULT_BASE_URL = "https://api.usetrinity.ai";

async function promptForCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Enter the pairing code shown in the Trinity dashboard: ")).trim();
  } finally {
    rl.close();
  }
}

async function exchange(baseUrl: string, code: string): Promise<DeviceConfig> {
  const res = await fetch(`${baseUrl}/api/v1/devices/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
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
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) {
    console.error("CLAUDE_PLUGIN_DATA is not set; cannot store credentials.");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
  const argCode = process.argv[2]?.trim();
  const code = argCode && argCode.length > 0 ? argCode : await promptForCode();
  if (!code) {
    console.error("No pairing code provided.");
    process.exitCode = 1;
    return;
  }

  try {
    const cfg = await exchange(baseUrl, code);
    saveConfig(dataDir, cfg);
    console.log("Trinity connected. This device now captures sessions for allowlisted repositories.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
