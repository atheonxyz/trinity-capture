// Credentials + policy cache live in the product's plugin-data dir
// (CLAUDE_PLUGIN_DATA), never in the repo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeviceConfig {
  token: string;
  ingestUrl: string;
  deviceId: string;
}

export interface Policy {
  etag: string;
  fetchedAt: number;
  ttlSeconds: number;
  captureLevel: "metadata";
  workspaces: { canonicalRepo: string; aliases: string[]; route: string }[];
}

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJSON(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

export function loadConfig(dir: string): DeviceConfig | null {
  const cfg = readJSON<DeviceConfig>(join(dir, "config.json"));
  if (!cfg || !cfg.token || !cfg.ingestUrl || !cfg.deviceId) return null;
  return cfg;
}

export function saveConfig(dir: string, cfg: DeviceConfig): void {
  writeJSON(dir, "config.json", cfg);
}

export function loadPolicy(dir: string): Policy | null {
  return readJSON<Policy>(join(dir, "policy.json"));
}

export function savePolicy(dir: string, policy: Policy): void {
  writeJSON(dir, "policy.json", policy);
}
