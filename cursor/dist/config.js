// Credentials + policy cache live in the product's plugin-data dir
// (CLAUDE_PLUGIN_DATA), never in the repo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}
export function loadConfig(dir) {
    const cfg = readJSON(join(dir, "config.json"));
    if (!cfg || !cfg.token || !cfg.ingestUrl || !cfg.deviceId)
        return null;
    return cfg;
}
export function saveConfig(dir, cfg) {
    writeJSON(dir, "config.json", cfg);
}
export function loadPolicy(dir) {
    return readJSON(join(dir, "policy.json"));
}
export function savePolicy(dir, policy) {
    writeJSON(dir, "policy.json", policy);
}
