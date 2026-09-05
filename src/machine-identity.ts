import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

export type MachineIdentityFailure =
  | "unsupported_platform"
  | "machine_identity_unavailable"
  | "machine_identity_invalid";

export type MachineIdReader = () => Promise<string>;

const MACHINE_ID_CONTEXT = "trinity-capture:machine:v1\0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;
const RESERVED_ZERO = "0".repeat(32);
const RESERVED_F = "f".repeat(32);
const MESSAGE_BY_REASON: Readonly<Record<MachineIdentityFailure, string>> = {
  unsupported_platform: "Trinity Capture pairing supports stable machine identity on macOS, Windows, and Linux.",
  machine_identity_unavailable: "Trinity Capture could not read this machine's OS identity. Pairing was not completed.",
  machine_identity_invalid: "Trinity Capture read an invalid OS machine identity. Pairing was not completed.",
};

let cachedMachineId: string | undefined;

export class MachineIdentityError extends Error {
  readonly reason: MachineIdentityFailure;

  constructor(reason: MachineIdentityFailure) {
    super(MESSAGE_BY_REASON[reason]);
    this.name = "MachineIdentityError";
    this.reason = reason;
  }
}

export function machineIdFromRawIdentifier(platformName: NodeJS.Platform, rawIdentifier: string): string {
  const canonicalIdentifier = normalizeMachineIdentifier(platformName, rawIdentifier);
  return createHmac("sha256", canonicalIdentifier)
    .update(`${MACHINE_ID_CONTEXT}${platformName}`)
    .digest("hex");
}

function normalizeMachineIdentifier(platformName: NodeJS.Platform, rawIdentifier: string): string {
  switch (platformName) {
    case "darwin":
    case "win32":
      return normalizeGuid(rawIdentifier);
    case "linux":
      return normalizeLinuxMachineId(rawIdentifier);
    default:
      throw new MachineIdentityError("unsupported_platform");
  }
}

export async function readMachineId(): Promise<string> {
  if (cachedMachineId !== undefined) return cachedMachineId;
  const platformName = platform();
  const rawIdentifier = readRawIdentifier(platformName);
  cachedMachineId = machineIdFromRawIdentifier(platformName, rawIdentifier);
  return cachedMachineId;
}

function normalizeGuid(rawIdentifier: string): string {
  const lower = stripLineEnding(rawIdentifier).toLowerCase();
  if (!UUID_PATTERN.test(lower)) throw new MachineIdentityError("machine_identity_invalid");
  const canonical = lower.replaceAll("-", "");
  if (isReserved(canonical)) throw new MachineIdentityError("machine_identity_invalid");
  return canonical;
}

function normalizeLinuxMachineId(rawIdentifier: string): string {
  const canonical = stripLineEnding(rawIdentifier);
  if (!HEX32_PATTERN.test(canonical) || isReserved(canonical)) {
    throw new MachineIdentityError("machine_identity_invalid");
  }
  return canonical;
}

function stripLineEnding(value: string): string {
  if (!value.endsWith("\n")) return value;
  const withoutLf = value.slice(0, -1);
  return withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
}

function readRawIdentifier(platformName: NodeJS.Platform): string {
  switch (platformName) {
    case "darwin":
      return readMacPlatformUuid();
    case "win32":
      return readWindowsMachineGuid();
    case "linux":
      return readLinuxMachineId();
    default:
      throw new MachineIdentityError("unsupported_platform");
  }
}

function readMacPlatformUuid(): string {
  const output = runOSCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
  if (match === null) throw new MachineIdentityError("machine_identity_unavailable");
  return match[1] ?? "";
}

function readWindowsMachineGuid(): string {
  const output = runOSCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
  const match = /\bMachineGuid\s+REG_\w+\s+([^\r\n]+)/.exec(output);
  if (match === null) throw new MachineIdentityError("machine_identity_unavailable");
  return match[1] ?? "";
}

function readLinuxMachineId(): string {
  try {
    return readFileSync("/etc/machine-id", "utf8");
  } catch (error) {
    if (error instanceof Error) throw new MachineIdentityError("machine_identity_unavailable");
    throw error;
  }
}

function runOSCommand(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
  } catch (error) {
    if (error instanceof Error) throw new MachineIdentityError("machine_identity_unavailable");
    throw error;
  }
}

function isReserved(canonicalIdentifier: string): boolean {
  return canonicalIdentifier === RESERVED_ZERO || canonicalIdentifier === RESERVED_F;
}
