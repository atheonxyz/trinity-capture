// A local stand-in for the Trinity agent-tools door and the policy read the
// proxy makes: POST /api/v1/agent/mcp answers however the test decides, GET
// /api/v1/ingest/policy answers a fresh policy. Shared by the in-process
// proxy suite and the three packaging suites that run the committed dists.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type JsonRpc = Record<string, unknown>;

export interface DoorRequest {
  readonly authorization: string | null;
  readonly accept: string | null;
  readonly contentType: string | null;
  readonly body: JsonRpc;
}

export interface Door {
  readonly origin: string;
  readonly mcpUrl: string;
  readonly ingestUrl: string;
  readonly requests: DoorRequest[];
  // Spread into every policy answer; a test sets mcpUrl here once it knows the port.
  readonly policy: Record<string, unknown>;
  policyRequests: number;
  close(): Promise<void>;
}

export type DoorAnswer = (request: DoorRequest, res: ServerResponse) => void;

export function answerJson(res: ServerResponse, message: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(message));
}

// One SSE event carrying the message; the stream stays open when asked, the
// way a door that expects a session close might leave it.
export function answerEventStream(res: ServerResponse, message: unknown, keepOpen = false): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  if (!keepOpen) res.end();
}

export function toolsListResult(id: unknown, names: readonly string[]): JsonRpc {
  return { jsonrpc: "2.0", id, result: { tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

export async function startDoor(answer: DoorAnswer, policy: Record<string, unknown> = {}): Promise<Door> {
  const requests: DoorRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/agent/mcp") {
      const request: DoorRequest = {
        authorization: req.headers.authorization ?? null,
        accept: req.headers.accept ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: JSON.parse(await readBody(req)) as JsonRpc,
      };
      requests.push(request);
      answer(request, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/ingest/policy") {
      door.policyRequests += 1;
      answerJson(res, { etag: `e${door.policyRequests}`, ttlSeconds: 900, captureLevel: "metadata", workspaces: [], ...door.policy });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const door: Door = {
    origin,
    mcpUrl: `${origin}/api/v1/agent/mcp`,
    ingestUrl: `${origin}/api/v1/ingest/batches`,
    requests,
    policy: { ...policy },
    policyRequests: 0,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  return door;
}

export interface McpRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly answers: JsonRpc[];
}

// Runs a committed dist entry the way a host does: JSON-RPC lines on stdin,
// stdin closed once they are written, answers read back from stdout.
export async function runMcpBinary(bin: string, env: NodeJS.ProcessEnv, lines: readonly JsonRpc[]): Promise<McpRun> {
  const child = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const [exitCode] = (await once(child, "close")) as [number | null];
  const answers = stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as JsonRpc);
  return { exitCode, stdout, stderr, answers };
}
