// The `/trinity-connect <code>` command: takes the pairing code as its one
// argument (never interactively — the command runs under a non-interactive
// `!` shell), calls POST /devices/exchange, writes the resulting
// DeviceConfig (spec §4.1).
import { pathToFileURL } from "node:url";
import { saveConfig } from "./config.js";
import { NETWORK_TIMEOUT_MS } from "./send.js";
const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;
function nodeMajorVersion() {
    return Number(process.versions.node.split(".")[0]);
}
// Exported for the e2e smoke test, which drives this exact call against a
// real backend rather than a raw fetch of its own.
export async function exchange(baseUrl, code) {
    const res = await fetch(`${baseUrl}/api/v1/devices/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(res.status === 404
            ? "That pairing code was not recognized or has expired."
            : `Exchange failed: ${res.status}`);
    }
    const body = (await res.json());
    return { token: body.token, ingestUrl: body.ingestUrl, deviceId: body.deviceId };
}
async function main() {
    if (nodeMajorVersion() < MIN_NODE_MAJOR) {
        console.error(`trinity-connect requires Node >= ${MIN_NODE_MAJOR} (found ${process.version}). ` +
            "Install a newer Node and re-run this command.");
        process.exitCode = 1;
        return;
    }
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!dataDir) {
        console.error("CLAUDE_PLUGIN_DATA is not set; cannot store credentials.");
        process.exitCode = 1;
        return;
    }
    const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
    const code = process.argv[2]?.trim() ?? "";
    if (code === "") {
        console.error("No pairing code provided. Usage: /trinity-connect <pairing-code>");
        process.exitCode = 1;
        return;
    }
    try {
        const cfg = await exchange(baseUrl, code);
        saveConfig(dataDir, cfg);
        console.log("Trinity connected. This device now captures sessions for allowlisted repositories.");
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
