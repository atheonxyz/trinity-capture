// The stdio proxy against a local stand-in for the Trinity agent-tools door.
// Every answer the proxy produces in this file is collected, and the last
// test holds that none of them carries the device token.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";
import { handleLine } from "../src/mcp.js";
import type { ProxyOptions } from "../src/mcp.js";
import { answerEventStream, answerJson, startDoor, toolsListResult } from "./helpers/mcp-door.js";
import type { Door, JsonRpc } from "./helpers/mcp-door.js";

const TOKEN = "device-token-that-must-never-print";
const everyAnswer: string[] = [];

async function ask(options: ProxyOptions, message: JsonRpc | JsonRpc[] | string): Promise<JsonRpc[]> {
  const answers = await handleLine(typeof message === "string" ? message : JSON.stringify(message), options);
  everyAnswer.push(...answers);
  return answers.map((answer) => JSON.parse(answer) as JsonRpc);
}

function proxy(dataDir: string | null, timeoutMs?: number): ProxyOptions {
  return { dataDir: async () => dataDir, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function pairedDir(door: Door, extra: Partial<DeviceConfig> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-mcp-data-"));
  saveConfig(dir, { token: TOKEN, ingestUrl: door.ingestUrl, deviceId: "dev1", ...extra });
  return dir;
}

function freshPolicy(extra: Partial<Policy> = {}): Policy {
  return { etag: "e0", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [], ...extra };
}

const request = (id: number, method: string, params?: unknown): JsonRpc => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

function errorOf(answer: JsonRpc | undefined): { code: number; message: string } {
  assert.ok(answer && typeof answer.error === "object" && answer.error !== null, `expected an error answer, got ${JSON.stringify(answer)}`);
  return answer.error as { code: number; message: string };
}

test("initialize and ping are answered locally, with no data directory at all", async () => {
  const options = proxy(null);
  const [init] = await ask(options, request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
  assert.equal(init.id, 1);
  assert.deepEqual((init.result as JsonRpc).protocolVersion, "2025-03-26");
  assert.deepEqual((init.result as JsonRpc).capabilities, { tools: {} });
  assert.deepEqual(((init.result as JsonRpc).serverInfo as JsonRpc).name, "trinity");

  const [newer] = await ask(options, request(2, "initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
  assert.equal((newer.result as JsonRpc).protocolVersion, "2025-06-18", "a version the door does not speak answers the newest it does");

  const [ping] = await ask(options, request(3, "ping"));
  assert.deepEqual(ping, { jsonrpc: "2.0", id: 3, result: {} });
});

test("a notification produces no output and never reaches the door", async () => {
  const door = await startDoor((_request, res) => answerJson(res, {}));
  try {
    const options = proxy(pairedDir(door, { mcpUrl: door.mcpUrl }));
    assert.deepEqual(await ask(options, { jsonrpc: "2.0", method: "notifications/initialized" }), []);
    assert.deepEqual(await ask(options, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), []);
    assert.deepEqual(await ask(options, { jsonrpc: "2.0", id: 7, result: {} }), [], "a client's response to a server request is dropped too");
    assert.equal(door.requests.length, 0);
  } finally {
    await door.close();
  }
});

test("unpaired: tools/list is empty and a call says Trinity is not connected here", async () => {
  const door = await startDoor((_request, res) => answerJson(res, {}));
  try {
    for (const dataDir of [null, mkdtempSync(join(tmpdir(), "trinity-mcp-unpaired-"))]) {
      const options = proxy(dataDir);
      const [list] = await ask(options, request(1, "tools/list"));
      assert.deepEqual(list, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
      const [call] = await ask(options, request(2, "tools/call", { name: "get_task", arguments: { task: "T1" } }));
      const error = errorOf(call);
      assert.equal(error.code, -32000);
      assert.match(error.message, /not connected on this machine/);
      assert.match(error.message, /Trinity setup from the dashboard/);
    }
    assert.equal(door.requests.length, 0);
  } finally {
    await door.close();
  }
});

test("paired with the address in config.json: the request is forwarded with the device token and relayed back", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task", "find_tasks"])));
  try {
    const options = proxy(pairedDir(door, { mcpUrl: door.mcpUrl }));
    const [list] = await ask(options, request(11, "tools/list"));
    assert.deepEqual(list, toolsListResult(11, ["get_task", "find_tasks"]));
    assert.equal(door.requests.length, 1);
    assert.equal(door.requests[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(door.requests[0].contentType, "application/json");
    assert.equal(door.requests[0].accept, "application/json, text/event-stream");
    assert.deepEqual(door.requests[0].body, request(11, "tools/list"));
    assert.equal(door.policyRequests, 0, "an address already known needs no policy read");
  } finally {
    await door.close();
  }
});

test("the address falls back to policy.json, then to one policy refresh", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])), { mcpUrl: undefined });
  try {
    const fromPolicy = pairedDir(door);
    savePolicy(fromPolicy, freshPolicy({ mcpUrl: door.mcpUrl }));
    const [viaPolicy] = await ask(proxy(fromPolicy), request(1, "tools/list"));
    assert.deepEqual(viaPolicy, toolsListResult(1, ["get_task"]));
    assert.equal(door.policyRequests, 0);

    const stale = pairedDir(door);
    savePolicy(stale, freshPolicy());
    const [afterRefresh] = await ask(proxy(stale), request(2, "tools/list"));
    assert.deepEqual(afterRefresh, { jsonrpc: "2.0", id: 2, result: { tools: [] } }, "a server that names no address leaves the list empty");
    assert.equal(door.policyRequests, 1, "the refresh is made once per request that finds no address");
    const [call] = await ask(proxy(stale), request(3, "tools/call", { name: "get_task", arguments: {} }));
    assert.match(errorOf(call).message, /has not offered agent tools to this machine yet/);
  } finally {
    await door.close();
  }
});

test("a policy refresh that learns the address saves it, and the next request reads it without asking again", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  door.policy.mcpUrl = door.mcpUrl;
  try {
    const options = proxy(pairedDir(door));
    const [first] = await ask(options, request(1, "tools/list"));
    assert.deepEqual(first, toolsListResult(1, ["get_task"]));
    assert.equal(door.policyRequests, 1);
    const [second] = await ask(options, request(2, "tools/list"));
    assert.deepEqual(second, toolsListResult(2, ["get_task"]));
    assert.equal(door.policyRequests, 1, "the saved policy now names the address");
  } finally {
    await door.close();
  }
});

test("an address on another origin than the token's is never used", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  try {
    const dir = pairedDir(door, { mcpUrl: "http://127.0.0.1:1/api/v1/agent/mcp" });
    const [list] = await ask(proxy(dir), request(1, "tools/list"));
    assert.deepEqual(list, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
    assert.equal(door.requests.length, 0);
  } finally {
    await door.close();
  }
});

test("an event-stream answer is relayed, and the read ends at this request's answer even when the stream stays open", async () => {
  const door = await startDoor((incoming, res) => answerEventStream(res, toolsListResult(incoming.body.id, ["get_task"]), incoming.body.id === 2));
  try {
    const options = proxy(pairedDir(door, { mcpUrl: door.mcpUrl }), 10_000);
    const [closed] = await ask(options, request(1, "tools/list"));
    assert.deepEqual(closed, toolsListResult(1, ["get_task"]));
    const started = Date.now();
    const [open] = await ask(options, request(2, "tools/list"));
    assert.deepEqual(open, toolsListResult(2, ["get_task"]));
    assert.ok(Date.now() - started < 5_000, "the open stream must not hold the answer to the timeout");
  } finally {
    await door.close();
  }
});

test("requests run concurrently and answer in the order the door answers them", async () => {
  const door = await startDoor((incoming, res) => {
    const delay = incoming.body.id === 1 ? 300 : 0;
    setTimeout(() => answerJson(res, { jsonrpc: "2.0", id: incoming.body.id, result: { content: [{ type: "text", text: String(incoming.body.id) }] } }), delay);
  });
  try {
    const options = proxy(pairedDir(door, { mcpUrl: door.mcpUrl }));
    const order: number[] = [];
    await Promise.all([1, 2].map(async (id) => {
      const [answer] = await ask(options, request(id, "tools/call", { name: "get_task", arguments: { task: `T${id}` } }));
      assert.equal(answer.id, id);
      order.push(id);
    }));
    assert.deepEqual(order, [2, 1]);
  } finally {
    await door.close();
  }
});

test("the saved connection is read fresh on every request, so a rotated token needs no restart", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, [])));
  try {
    const dir = pairedDir(door, { mcpUrl: door.mcpUrl });
    const options = proxy(dir);
    await ask(options, request(1, "tools/list"));
    saveConfig(dir, { token: "rotated-token", ingestUrl: door.ingestUrl, deviceId: "dev1", mcpUrl: door.mcpUrl });
    await ask(options, request(2, "tools/list"));
    assert.deepEqual(door.requests.map((incoming) => incoming.authorization), [`Bearer ${TOKEN}`, "Bearer rotated-token"]);
  } finally {
    await door.close();
  }
});

test("401 and 403 say the connection was revoked or replaced", async () => {
  const door = await startDoor((incoming, res) => {
    res.writeHead(incoming.body.id === 1 ? 401 : 403).end();
  });
  try {
    const options = proxy(pairedDir(door, { mcpUrl: door.mcpUrl }));
    for (const id of [1, 2]) {
      const [answer] = await ask(options, request(id, "tools/call", { name: "get_task", arguments: {} }));
      const error = errorOf(answer);
      assert.equal(error.code, -32001);
      assert.match(error.message, /revoked or replaced/);
      assert.match(error.message, /Re-pair it from the Trinity dashboard/);
    }
  } finally {
    await door.close();
  }
});

test("a door that cannot be reached, times out, or answers another status is named in the error", async () => {
  const silent = await startDoor(() => {});
  const failing = await startDoor((_incoming, res) => {
    res.writeHead(503).end();
  });
  try {
    const call = request(1, "tools/call", { name: "get_task", arguments: {} });
    const closedPort = mkdtempSync(join(tmpdir(), "trinity-mcp-data-"));
    saveConfig(closedPort, { token: TOKEN, ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1", mcpUrl: "http://127.0.0.1:1/api/v1/agent/mcp" });
    const [unreachable] = await ask(proxy(closedPort), call);
    assert.equal(errorOf(unreachable).code, -32002);
    assert.match(errorOf(unreachable).message, /could not be reached/);

    const [timedOut] = await ask(proxy(pairedDir(silent, { mcpUrl: silent.mcpUrl }), 200), call);
    assert.equal(errorOf(timedOut).code, -32002);
    assert.match(errorOf(timedOut).message, /could not be reached \(TimeoutError/);

    const [status] = await ask(proxy(pairedDir(failing, { mcpUrl: failing.mcpUrl })), call);
    assert.deepEqual(errorOf(status), { code: -32002, message: "Trinity answered HTTP 503." });
  } finally {
    await silent.close();
    await failing.close();
  }
});

test("a malformed line answers a parse error and a batch answers as one array", async () => {
  const [parse] = await ask(proxy(null), "{not json");
  assert.deepEqual(parse, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  const [batch] = await ask(proxy(null), [request(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, request(2, "tools/list")]);
  assert.deepEqual(batch, [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: { tools: [] } }]);
  assert.deepEqual(await ask(proxy(null), [{ jsonrpc: "2.0", method: "notifications/initialized" }]), []);
});

test("no answer the proxy produced carries the device token", () => {
  assert.ok(everyAnswer.length > 0);
  for (const answer of everyAnswer) assert.ok(!answer.includes(TOKEN), `token leaked: ${answer}`);
});
