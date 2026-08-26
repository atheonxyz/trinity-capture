import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeDialect } from "../../src/claude-hook.js";
import { runHook } from "../../src/hook-core.js";

export function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-data-"));
}

export function initRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-repo-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Trinity Test",
    GIT_AUTHOR_EMAIL: "test@trinity.dev",
    GIT_COMMITTER_NAME: "Trinity Test",
    GIT_COMMITTER_EMAIL: "test@trinity.dev",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

export function outboxFiles(dataDir: string): string[] {
  const dir = join(dataDir, "outbox");
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function runClaudeHook(
  eventName: string,
  input: Record<string, unknown>,
  dataDir: string,
): Promise<void> {
  return runHook(claudeCodeDialect, eventName, JSON.stringify(input), {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
  });
}

export function stubFetch(options: {
  readonly onPolicy?: () => Response;
  readonly onBatch?: (items: readonly { readonly captureEventId: string }[]) => Response;
}): () => void {
  const original = globalThis.fetch;
  const stub: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/policy")) {
      if (!options.onPolicy) throw new Error(`unexpected policy fetch: ${href}`);
      return options.onPolicy();
    }
    if (href.endsWith("/batches")) {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed !== "object" || parsed === null || !("items" in parsed) || !Array.isArray(parsed.items)) {
        throw new Error("batch body has no items");
      }
      const items = parsed.items.filter(
        (item): item is { readonly captureEventId: string } =>
          typeof item === "object" && item !== null && "captureEventId" in item && typeof item.captureEventId === "string",
      );
      if (options.onBatch) return options.onBatch(items);
      return Response.json({
        results: items.map((item) => ({ captureEventId: item.captureEventId, outcome: "retry_later" })),
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}

export const sessionStartInput = {
  session_id: "s1",
  hook_event_name: "SessionStart",
  transcript_path: "/Users/dev/.claude/transcripts/s1.jsonl",
  model: "claude-fable-5",
} as const;
