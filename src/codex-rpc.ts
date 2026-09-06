import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import type { CodexHookSetupRpc, ConfigBatchWriteParams, HookMetadata, HooksSnapshot } from "./codex-hook-setup.js";

const RPC_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type RpcResponse = { readonly id: number; readonly result?: unknown; readonly error?: { readonly message: string } };

export class NativeCodexRpc implements CodexHookSetupRpc {
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly sourcePath: string;
  private readonly pending = new Map<number, (message: RpcResponse) => void>();
  private buffer = "";
  private outputBytes = 0;

  private constructor(child: ChildProcessWithoutNullStreams, sourcePath: string) {
    this.child = child;
    this.sourcePath = sourcePath;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.outputBytes += Buffer.byteLength(chunk);
      if (this.outputBytes > MAX_OUTPUT_BYTES) this.close();
    });
    child.stdin.on("error", (error) => this.rejectPending(`native Codex RPC input error: ${error.message}`));
    child.on("error", (error) => this.rejectPending(`native Codex RPC process error: ${error.message}`));
    child.on("close", () => this.rejectPending("native Codex RPC process closed"));
  }

  static async create(codexPath: string, sourcePath: string): Promise<NativeCodexRpc> {
    const child = spawn(codexPath, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = new NativeCodexRpc(child, sourcePath);
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "trinity-capture", title: null, version: "0.3.9" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify("initialized");
      return rpc;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async hooksList(): Promise<HooksSnapshot> {
    const response = await this.request("hooks/list", { cwds: [] });
    const data = readArray(readObject(response).data);
    const hooks: HookMetadata[] = [];
    const errors: string[] = [];
    for (const entryValue of data) {
      const entry = readObject(entryValue);
      hooks.push(...readArray(entry.hooks).filter((hook) => rawHookSourceMatches(hook, this.sourcePath)).map(parseHookMetadata));
      errors.push(...readArray(entry.errors).map((error) => JSON.stringify(error)));
    }
    return { hooks, errors };
  }

  async configBatchWrite(params: ConfigBatchWriteParams): Promise<void> {
    await this.request("config/batchWrite", params);
  }

  close(): void {
    if (!this.child.killed) this.child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.close();
        reject(new Error("native Codex RPC timed out"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
    });
  }

  private notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private rejectPending(message: string): void {
    for (const resolve of this.pending.values()) resolve({ id: -1, error: { message } });
    this.pending.clear();
  }

  private handleData(chunk: string): void {
    try {
      this.outputBytes += Buffer.byteLength(chunk);
      if (this.outputBytes > MAX_OUTPUT_BYTES) {
        this.close();
        return;
      }
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index === -1) return;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        const response = parseRpcResponse(JSON.parse(line));
        if (!response) continue;
        const resolve = this.pending.get(response.id);
        if (resolve) {
          this.pending.delete(response.id);
          resolve(response);
        }
      }
    } catch (error) {
      this.rejectPending(`native Codex RPC returned malformed response: ${error instanceof Error ? error.message : String(error)}`);
      this.close();
    }
  }
}

function parseRpcResponse(value: unknown): RpcResponse | null {
  const object = readObject(value);
  const id = object.id;
  if (id === undefined) return null;
  if (typeof id !== "number") throw new Error("native Codex RPC returned response without numeric id");
  if ("error" in object) {
    const error = readObject(object.error);
    const message = typeof error.message === "string" ? error.message : "native Codex RPC error";
    return { id, error: { message } };
  }
  return { id, result: object.result };
}

function rawHookSourceMatches(value: unknown, sourcePath: string): boolean {
  const object = readObject(value);
  return typeof object.sourcePath === "string" && sameRealPath(object.sourcePath, sourcePath);
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function parseHookMetadata(value: unknown): HookMetadata {
  const object = readObject(value);
  if (object.handlerType !== "command") throw new Error("native Codex returned non-command hook metadata");
  return {
    key: readString(object.key),
    eventName: readHookEventName(object.eventName),
    matcher: object.matcher === null ? null : readString(object.matcher),
    sourcePath: readString(object.sourcePath),
    source: readString(object.source),
    pluginId: object.pluginId === null ? null : readString(object.pluginId),
    enabled: readBoolean(object.enabled),
    isManaged: readBoolean(object.isManaged),
    currentHash: readString(object.currentHash),
    trustStatus: readHookTrustStatus(object.trustStatus),
    handlerType: "command",
    command: readString(object.command),
    async: readBoolean(object.async),
  };
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new Error("expected object");
}

function readArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error("expected array");
}

function readString(value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error("expected string");
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error("expected boolean");
}

function readHookEventName(value: unknown): HookMetadata["eventName"] {
  if (value === "sessionStart" || value === "userPromptSubmit" || value === "preToolUse" || value === "postToolUse" || value === "stop" || value === "sessionEnd") return value;
  throw new Error("unexpected hook event");
}

function readHookTrustStatus(value: unknown): HookMetadata["trustStatus"] {
  if (value === "managed" || value === "untrusted" || value === "trusted" || value === "modified") return value;
  throw new Error("unexpected hook trust status");
}

