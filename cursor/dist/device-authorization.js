import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { REQUEST_TIMEOUT_MS } from "./send.js";
function field(body, name) {
    return typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
}
function requiredString(body, name) {
    const value = field(body, name);
    if (typeof value !== "string" || value === "")
        throw new Error(`Trinity returned an invalid ${name}.`);
    return value;
}
function requiredPositiveNumber(body, name) {
    const value = field(body, name);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`Trinity returned an invalid ${name}.`);
    }
    return value;
}
function verificationURL(body, baseURL) {
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
export async function startDeviceAuthorization(baseURL, deviceName) {
    const response = await fetch(`${baseURL}/api/v1/devices/authorize/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "cursor", name: deviceName }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`Unable to start Trinity authorization (${response.status}).`);
    const body = await response.json();
    return {
        deviceCode: requiredString(body, "deviceCode"),
        verificationURL: verificationURL(body, baseURL),
        verificationCode: requiredString(body, "verificationCode"),
        expiresInSeconds: requiredPositiveNumber(body, "expiresInSeconds"),
        intervalSeconds: requiredPositiveNumber(body, "intervalSeconds"),
    };
}
export async function exchangeDeviceAuthorization(baseURL, deviceCode) {
    const response = await fetch(`${baseURL}/api/v1/devices/authorize/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 202)
        return { status: "pending" };
    if (!response.ok) {
        throw new Error(response.status === 404
            ? "This Trinity authorization expired. Run /trinity-connect again."
            : `Unable to finish Trinity authorization (${response.status}).`);
    }
    const body = await response.json();
    return {
        status: "connected",
        config: {
            token: requiredString(body, "token"),
            deviceId: requiredString(body, "deviceId"),
            ingestUrl: requiredString(body, "ingestUrl"),
        },
    };
}
export function openBrowserURL(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
        return false;
    }
    const command = platform() === "darwin" ? ["open", [parsed.toString()]]
        : platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", parsed.toString()]]
            : ["xdg-open", [parsed.toString()]];
    const result = spawnSync(command[0], command[1], { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
}
export function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
