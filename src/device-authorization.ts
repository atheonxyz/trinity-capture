import { spawnSync } from "node:child_process";
import { hostname, platform } from "node:os";

import type { DeviceConfig } from "./config.js";
import { REQUEST_TIMEOUT_MS } from "./send.js";

type DeviceAuthorization = {
  readonly deviceCode: string;
  readonly verificationURL: string;
  readonly verificationCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
};

export type DeviceAuthorizationExchange =
  | { readonly status: "pending" }
  | { readonly status: "connected"; readonly config: DeviceConfig };

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
}

function requiredString(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== "string" || value === "") throw new Error(`Trinity returned an invalid ${name}.`);
  return value;
}

function requiredPositiveNumber(body: unknown, name: string): number {
  const value = field(body, name);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Trinity returned an invalid ${name}.`);
  }
  return value;
}

function verificationURL(body: unknown, baseURL: string): string {
  const raw = requiredString(body, "verificationUrl");
  const url = new URL(raw);
  const base = new URL(baseURL);
  const trustedOrigins = new Set(["https://app.usetrinity.ai", "https://staging.usetrinity.ai"]);
  const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    && url.protocol === "http:";
  if ((!trustedOrigins.has(url.origin) && !local) || !url.searchParams.has("device_request")) {
    throw new Error("Trinity returned an untrusted verification URL.");
  }
  return url.toString();
}

export async function startDeviceAuthorization(baseURL: string, deviceName: string): Promise<DeviceAuthorization> {
  const response = await fetch(`${baseURL}/api/v1/devices/authorize/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "cursor", name: deviceName }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Unable to start Trinity authorization (${response.status}).`);
  const body: unknown = await response.json();
  return {
    deviceCode: requiredString(body, "deviceCode"),
    verificationURL: verificationURL(body, baseURL),
    verificationCode: requiredString(body, "verificationCode"),
    expiresInSeconds: requiredPositiveNumber(body, "expiresInSeconds"),
    intervalSeconds: requiredPositiveNumber(body, "intervalSeconds"),
  };
}

export async function exchangeDeviceAuthorization(
  baseURL: string,
  deviceCode: string,
  machineId: string,
): Promise<DeviceAuthorizationExchange> {
  const response = await fetch(`${baseURL}/api/v1/devices/authorize/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode, hostname: hostname(), machineId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 202) return { status: "pending" };
  if (!response.ok) {
    throw new Error(response.status === 404
      ? "This Trinity authorization expired. Run /trinity-connect again."
      : `Unable to finish Trinity authorization (${response.status}).`);
  }
  const body: unknown = await response.json();
  return {
    status: "connected",
    config: {
      token: requiredString(body, "token"),
      deviceId: requiredString(body, "deviceId"),
      ingestUrl: requiredString(body, "ingestUrl"),
    },
  };
}

export function openBrowserURL(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
    return false;
  }
  const command = platform() === "darwin" ? ["open", [parsed.toString()]] as const
    : platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", parsed.toString()]] as const
      : ["xdg-open", [parsed.toString()]] as const;
  const result = spawnSync(command[0], command[1], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
