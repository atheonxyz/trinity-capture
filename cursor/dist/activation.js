import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { saveActivation } from "./config.js";
function activationPath(dataDir) {
    return join(dataDir, "activation.json");
}
function sessionPath(dataDir, tool, sessionId) {
    return join(dataDir, "active-sessions", `${tool}-${encodeURIComponent(sessionId)}`);
}
function readActivation(dataDir) {
    try {
        const parsed = JSON.parse(readFileSync(activationPath(dataDir), "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return { kind: "invalid" };
        const record = parsed;
        if (record.mode !== "awaiting_new_session" && record.mode !== "ready")
            return { kind: "invalid" };
        if (typeof record.deviceId !== "string" || record.deviceId === "")
            return { kind: "invalid" };
        if (typeof record.pairedAt !== "number")
            return { kind: "invalid" };
        return { kind: "ok", state: {
                mode: record.mode,
                deviceId: record.deviceId,
                pairedAt: record.pairedAt,
                ...(typeof record.readyAt === "number" ? { readyAt: record.readyAt } : {}),
                ...(typeof record.capturedAt === "number" ? { capturedAt: record.capturedAt } : {}),
            } };
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { kind: "missing" };
        if (error instanceof Error)
            return { kind: "invalid" };
        throw error;
    }
}
function loadActivation(dataDir) {
    const read = readActivation(dataDir);
    return read.kind === "ok" ? read.state : null;
}
export function markPairedAwaitingNewSession(dataDir, deviceId, now = Date.now()) {
    saveActivation(dataDir, { mode: "awaiting_new_session", deviceId, pairedAt: now });
}
function markReady(dataDir, now = Date.now()) {
    const existing = loadActivation(dataDir);
    if (!existing)
        return;
    saveActivation(dataDir, {
        mode: "ready",
        deviceId: existing.deviceId,
        pairedAt: existing.pairedAt,
        readyAt: existing.readyAt ?? now,
        ...(existing.capturedAt === undefined ? {} : { capturedAt: existing.capturedAt }),
    });
}
export function markCaptured(dataDir, deviceId, now = Date.now()) {
    const existing = loadActivation(dataDir);
    if (existing && existing.deviceId !== deviceId)
        return;
    saveActivation(dataDir, {
        mode: "ready",
        deviceId,
        pairedAt: existing?.pairedAt ?? now,
        readyAt: existing?.readyAt ?? now,
        capturedAt: existing?.capturedAt ?? now,
    });
}
export function activationStatus(dataDir) {
    const config = loadConfig(dataDir);
    if (!config)
        return "unpaired";
    const read = readActivation(dataDir);
    if (read.kind === "invalid")
        return "needs-repair";
    const state = read.kind === "ok" ? read.state : null;
    if (state && state.deviceId !== config.deviceId)
        return "needs-repair";
    if (state?.capturedAt !== undefined)
        return "captured";
    if (state?.mode === "awaiting_new_session")
        return "paired-awaiting-new-session";
    return "ready";
}
function sessionHasDevice(dataDir, tool, sessionId, deviceId) {
    try {
        return readFileSync(sessionPath(dataDir, tool, sessionId), "utf8") === deviceId;
    }
    catch (error) {
        if (error instanceof Error)
            return false;
        throw error;
    }
}
export function allowSessionCapture(options) {
    const read = readActivation(options.dataDir);
    if (read.kind === "missing")
        return true;
    if (read.kind === "invalid" || read.state.deviceId !== options.deviceId || options.sessionId === "")
        return false;
    if (options.isSessionStart) {
        if (sessionHasDevice(options.dataDir, options.tool, options.sessionId, read.state.deviceId))
            return true;
        if (!options.isFreshSessionStart)
            return false;
        markReady(options.dataDir);
        mkdirSync(join(options.dataDir, "active-sessions"), { recursive: true, mode: 0o700 });
        writeFileSync(sessionPath(options.dataDir, options.tool, options.sessionId), read.state.deviceId, { mode: 0o600 });
        return true;
    }
    return sessionHasDevice(options.dataDir, options.tool, options.sessionId, read.state.deviceId);
}
