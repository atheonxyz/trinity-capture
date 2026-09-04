import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function readJSON(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
}
function writeJSON(dir, name, value) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, name);
    const temporary = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
export function loadConfig(dir) {
    const path = join(dir, "config.json");
    const cfg = readJSON(path);
    if (!cfg || !cfg.token || !cfg.ingestUrl || !cfg.deviceId)
        return null;
    try {
        chmodSync(dir, 0o700);
        chmodSync(path, 0o600);
    }
    catch {
        return null;
    }
    return cfg;
}
export function saveConfig(dir, cfg) {
    const existing = loadConfig(dir);
    if (existing === null || existing.deviceId !== cfg.deviceId) {
        const sources = ["outbox", "active-sessions", "turnkeys"].filter((name) => existsSync(join(dir, name)));
        if (sources.length > 0) {
            const retired = join(dir, "retired", randomUUID());
            mkdirSync(retired, { recursive: true, mode: 0o700 });
            for (const name of sources)
                renameSync(join(dir, name), join(retired, name));
        }
        try {
            unlinkSync(join(dir, "policy.json"));
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
        }
        rmSync(join(dir, "github-repositories.json"), { force: true });
    }
    writeJSON(dir, "config.json", cfg);
}
export function loadPolicy(dir) {
    return readJSON(join(dir, "policy.json"));
}
export function savePolicy(dir, policy) {
    writeJSON(dir, "policy.json", policy);
}
export function saveActivation(dir, value) {
    writeJSON(dir, "activation.json", value);
}
export function saveGitHubRepositoryCache(dir, value) {
    writeJSON(dir, "github-repositories.json", value);
}
