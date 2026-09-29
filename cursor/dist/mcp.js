// The stdio MCP server each plugin bundles: the one long-lived process this
// repository ships, started by the host beside the plugin and ending with it.
// It answers the handshake itself, so the host connects even offline or
// unpaired, and forwards every other request as one POST to the paired
// Trinity server's stateless Streamable-HTTP door, reading the saved
// connection fresh each time so a re-pair needs no restart. stdout carries
// JSON-RPC lines only; the device token is never written anywhere.
import { createInterface } from "node:readline";
import { loadConfig, loadPolicy, sameOrigin } from "./config.js";
import { refreshPolicy } from "./send.js";
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const NOT_CONNECTED = -32000;
const REVOKED = -32001;
const UNREACHABLE = -32002;
class DoorError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorResponse(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
}
// The address comes from what the server sent, config.json first and the
// policy document second, refreshed once when neither names one. The token
// is the ingest origin's, so an address on any other origin is not used.
export async function resolveConnection(dataDir) {
    const cfg = dataDir === null ? null : loadConfig(dataDir);
    if (dataDir === null || cfg === null)
        return { state: "unpaired" };
    let url = cfg.mcpUrl ?? loadPolicy(dataDir)?.mcpUrl;
    if (url === undefined) {
        try {
            url = (await refreshPolicy(dataDir, cfg))?.mcpUrl;
        }
        catch (error) {
            if (!(error instanceof Error))
                throw error;
        }
    }
    if (url === undefined || !sameOrigin(url, new URL(cfg.ingestUrl).origin))
        return { state: "no_tools_address" };
    return { state: "ready", token: cfg.token, mcpUrl: url };
}
function initializeResult(params) {
    const asked = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "trinity", title: "Trinity", version: "1" },
        instructions: "Read-only tools over the Trinity workspace this machine is paired with: its tasks, milestones and their context.",
    };
}
async function readEventStream(body, id) {
    if (body === null)
        return [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const messages = [];
    let buffered = "";
    for (;;) {
        const { value, done } = await reader.read();
        buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const events = buffered.split(/\r?\n\r?\n/);
        buffered = done ? "" : (events.pop() ?? "");
        for (const event of events) {
            const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
            if (data === "")
                continue;
            const parsed = JSON.parse(data);
            if (!isRecord(parsed))
                continue;
            messages.push(parsed);
            // The answer to this request ends the read: a door that keeps the
            // stream open afterwards must not hold the tool call to the timeout.
            if (parsed.id === id && ("result" in parsed || "error" in parsed)) {
                await reader.cancel();
                return messages;
            }
        }
        if (done)
            return messages;
    }
}
async function forward(connection, message, id, timeoutMs) {
    const res = await fetch(connection.mcpUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${connection.token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
        throw new DoorError(REVOKED, "This device's Trinity connection was revoked or replaced. Re-pair it from the Trinity dashboard.");
    }
    if (res.status === 202 || res.status === 204)
        throw new DoorError(UNREACHABLE, `Trinity answered HTTP ${res.status} with no result.`);
    if (!res.ok)
        throw new DoorError(UNREACHABLE, `Trinity answered HTTP ${res.status}.`);
    if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream"))
        return readEventStream(res.body, id);
    const body = await res.json();
    return (Array.isArray(body) ? body : [body]).filter(isRecord);
}
async function handleMessage(message, options) {
    if (!isRecord(message))
        return [errorResponse(null, INVALID_REQUEST, "Invalid request")];
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    // A notification (initialized, cancelled, roots changed) means nothing to a
    // stateless door, and a response answers a request no such door can make.
    if (id === undefined || method === undefined)
        return [];
    if (method === "initialize")
        return [{ jsonrpc: "2.0", id, result: initializeResult(message.params) }];
    if (method === "ping")
        return [{ jsonrpc: "2.0", id, result: {} }];
    try {
        const connection = await resolveConnection(await options.dataDir());
        if (connection.state === "ready")
            return await forward(connection, message, id, options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS);
        if (method === "tools/list")
            return [{ jsonrpc: "2.0", id, result: { tools: [] } }];
        return [errorResponse(id, NOT_CONNECTED, connection.state === "unpaired"
                ? "Trinity is not connected on this machine. Run the Trinity setup from the dashboard to pair it."
                : "The paired Trinity server has not offered agent tools to this machine yet. Run the Trinity setup from the dashboard once it does.")];
    }
    catch (error) {
        if (!(error instanceof Error))
            throw error;
        if (error instanceof DoorError)
            return [errorResponse(id, error.code, error.message)];
        const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
        const detail = `${error.name === "Error" ? "" : `${error.name}: `}${error.message}${cause}`;
        return [errorResponse(id, error.name === "TimeoutError" || error.name === "TypeError" ? UNREACHABLE : INTERNAL_ERROR, `Trinity could not be reached (${detail}).`)];
    }
}
// One stdin line in, zero or more stdout lines out. A batch (arrays are
// allowed by the two older protocol versions) answers as one array line.
export async function handleLine(line, options) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (error) {
        if (!(error instanceof SyntaxError))
            throw error;
        return [JSON.stringify(errorResponse(null, PARSE_ERROR, "Parse error"))];
    }
    if (!Array.isArray(parsed))
        return (await handleMessage(parsed, options)).map((answer) => JSON.stringify(answer));
    const answers = (await Promise.all(parsed.map((message) => handleMessage(message, options)))).flat();
    return answers.length === 0 ? [] : [JSON.stringify(answers)];
}
// Requests run concurrently and answer in the order they finish. The process
// ends when the host closes stdin and every answer already owed has landed.
export function runProxy(options) {
    process.stdout.on("error", () => process.exit(0));
    let inFlight = 0;
    let closed = false;
    const finish = () => {
        if (closed && inFlight === 0)
            process.exit(0);
    };
    const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
    lines.on("line", (line) => {
        if (line.trim() === "")
            return;
        inFlight += 1;
        handleLine(line, options)
            .then((answers) => {
            for (const answer of answers)
                process.stdout.write(`${answer}\n`);
        }, () => { })
            .finally(() => {
            inFlight -= 1;
            finish();
        });
    });
    lines.on("close", () => {
        closed = true;
        finish();
    });
}
