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
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BASE_URL, exchange, supportsNodeVersion } from "./connect.js";
import { saveConfig } from "./config.js";
// Exported so codex-hook.ts's promotion step and this suite's tests resolve
// the exact same home and pending path.
export function codexHome(env) {
    return env.CODEX_HOME ?? join(homedir(), ".codex");
}
export function pendingConfigPath(home) {
    return join(home, "trinity-capture", "pending-device.json");
}
export function confirmedConfigPath(home) {
    return join(home, "trinity-capture", "connected-device.json");
}
function writePrivateJSON(home, name, value) {
    const dir = join(home, "trinity-capture");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, name);
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
}
// Atomic (temp+rename, same directory) and mode-0600. This directory is
// NOT PLUGIN_DATA — it's a plugin-managed corner of CODEX_HOME the skill can
// reach without that env var, secured the same way PLUGIN_DATA's own
// credential file is.
export function writePendingConfig(home, cfg) {
    rmSync(confirmedConfigPath(home), { force: true });
    writePrivateJSON(home, "pending-device.json", cfg);
}
function trustedDeviceConfig(value, baseUrl) {
    if (typeof value !== "object" || value === null)
        return null;
    if (!("token" in value) || typeof value.token !== "string" || value.token === "")
        return null;
    if (!("deviceId" in value) || typeof value.deviceId !== "string" || value.deviceId === "")
        return null;
    if (!("ingestUrl" in value) || typeof value.ingestUrl !== "string")
        return null;
    try {
        const ingest = new URL(value.ingestUrl);
        const base = new URL(baseUrl);
        if (ingest.origin !== base.origin || !ingest.pathname.endsWith("/api/v1/ingest/batches"))
            return null;
    }
    catch (error) {
        if (error instanceof TypeError)
            return null;
        throw error;
    }
    return { token: value.token, ingestUrl: value.ingestUrl, deviceId: value.deviceId };
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
export function promotePendingConfig(home, pluginDataDir, baseUrl = DEFAULT_BASE_URL) {
    const pending = pendingConfigPath(home);
    if (!existsSync(pending))
        return;
    const cfg = trustedDeviceConfig(JSON.parse(readFileSync(pending, "utf8")), baseUrl);
    if (!cfg)
        return;
    saveConfig(pluginDataDir, cfg);
    writePrivateJSON(home, "connected-device.json", { deviceId: cfg.deviceId });
    unlinkSync(pending);
}
export function connectionStatus(home) {
    if (existsSync(pendingConfigPath(home)))
        return "pending";
    if (existsSync(confirmedConfigPath(home)))
        return "connected";
    return "unpaired";
}
async function main() {
    if (!supportsNodeVersion(process.versions.node)) {
        console.error(`trinity-connect requires Node >= 20 (found ${process.version}).`);
        process.exitCode = 1;
        return;
    }
    const home = codexHome(process.env);
    const arg = process.argv[2]?.trim() ?? "";
    if (arg === "--status") {
        const status = connectionStatus(home);
        if (status === "pending") {
            console.log("Trinity pairing recorded but not yet confirmed. Run any Codex tool call, then " +
                "run /trinity-connect --status again.");
        }
        else if (status === "connected") {
            console.log("Trinity connected. This device now captures sessions for allowlisted repositories.");
        }
        else {
            console.log("Trinity is not paired. Run /trinity-connect <pairing-code> first.");
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
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    }
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main();
}
