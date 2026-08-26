import { chmodSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cursorDialect } from "./cursor-hook.js";
import { exchange } from "./connect.js";
import { saveConfig } from "./config.js";
import { isPolicyFresh } from "./gate.js";
import { refreshPolicy } from "./send.js";
import { exchangeDeviceAuthorization, openBrowserURL, startDeviceAuthorization, wait } from "./device-authorization.js";
const DEFAULT_BASE_URL = "https://api.usetrinity.ai";
const MIN_NODE_MAJOR = 20;
function securePosixMode(path, mode) {
    if (platform() === "win32")
        return;
    chmodSync(path, mode);
}
export async function connectCursor(baseUrl, code, dataDir) {
    const cfg = await exchange(baseUrl, code);
    await saveCursorConnection(dataDir, cfg);
}
async function saveCursorConnection(dataDir, cfg) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    securePosixMode(dataDir, 0o700);
    saveConfig(dataDir, cfg);
    securePosixMode(join(dataDir, "config.json"), 0o600);
    const policy = await refreshPolicy(dataDir, cfg);
    if (!isPolicyFresh(policy, Date.now())) {
        throw new Error("Trinity paired the device, but capture policy could not be synced. Run the connect command again.");
    }
}
export async function authorizeCursor(options) {
    const authorization = await startDeviceAuthorization(options.baseUrl, options.deviceName);
    const openURL = options.openURL ?? ((url) => {
        if (!openBrowserURL(url))
            console.log(`Open this link to connect Cursor: ${url}`);
    });
    const pause = options.wait ?? wait;
    const showVerificationCode = options.showVerificationCode ?? ((code) => {
        console.log(`Confirm code ${code} in the Trinity browser tab.`);
    });
    showVerificationCode(authorization.verificationCode);
    openURL(authorization.verificationURL);
    const expiresAt = Date.now() + authorization.expiresInSeconds * 1000;
    while (Date.now() < expiresAt) {
        const exchange = await exchangeDeviceAuthorization(options.baseUrl, authorization.deviceCode);
        if (exchange.status === "connected") {
            await saveCursorConnection(options.dataDir, exchange.config);
            return;
        }
        await pause(authorization.intervalSeconds * 1000);
    }
    throw new Error("This Trinity authorization expired. Run /trinity-connect again.");
}
async function main() {
    const nodeMajorVersion = Number(process.versions.node.split(".")[0]);
    if (nodeMajorVersion < MIN_NODE_MAJOR) {
        console.error(`trinity-connect requires Node >= ${MIN_NODE_MAJOR} (found ${process.version}). ` +
            "Install a newer Node and re-run this command.");
        process.exitCode = 1;
        return;
    }
    const dataDir = cursorDialect.dataDir(process.env);
    if (!dataDir) {
        console.error("Could not resolve a Trinity Capture data directory (set TRINITY_CAPTURE_DATA to override).");
        process.exitCode = 1;
        return;
    }
    const baseUrl = process.env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL;
    const code = process.argv[2]?.trim() ?? "";
    try {
        if (code === "") {
            console.log("Opening Trinity to approve this Cursor connection…");
            await authorizeCursor({ baseUrl, dataDir, deviceName: "Cursor" });
        }
        else {
            await connectCursor(baseUrl, code, dataDir);
        }
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
