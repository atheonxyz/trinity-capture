import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveGitHubRepositoryCache } from "./config.js";

interface CacheEntry {
  readonly id: number | null;
  readonly checkedAt: number;
}

interface RepositoryCache {
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_FILE = "github-repositories.json";
const POSITIVE_TTL_MS = 15 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

function cachePath(dataDir: string): string {
  return join(dataDir, CACHE_FILE);
}

function cacheKey(fullName: string): string {
  return createHash("sha256").update(fullName).digest("hex");
}

function loadCache(dataDir: string): RepositoryCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(dataDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) return { entries: {} };
    const entries = (parsed as { readonly entries: unknown }).entries;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return { entries: {} };
    const out: Record<string, CacheEntry> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      if ((typeof id !== "number" && id !== null) || typeof record.checkedAt !== "number") continue;
      out[name] = { id, checkedAt: record.checkedAt };
    }
    return { entries: out };
  } catch (error) {
    if (error instanceof Error) return { entries: {} };
    throw error;
  }
}

function cached(cache: RepositoryCache, key: string, now: number): number | null | undefined {
  const entry = cache.entries[key];
  if (!entry) return undefined;
  const ttl = entry.id === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  return now - entry.checkedAt <= ttl ? entry.id : undefined;
}

function parseRepositoryId(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
    const id = (parsed as { readonly id: unknown }).id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

function lookupWithGh(fullName: string, timeoutMs: number): number | null | undefined {
  try {
    const out = execFileSync("gh", ["api", "--hostname", "github.com", `repos/${fullName}`, "--jq", ".id"], {
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    });
    return parseRepositoryId(out);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

async function lookupWithGitHubAPI(fullName: string, timeoutMs: number): Promise<number | null | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return parseRepositoryId(JSON.stringify(await res.json()));
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

export async function resolveGitHubRepository(
  dataDir: string,
  fullName: string,
  timeoutMs = 1_500,
): Promise<number | null> {
  const cache = loadCache(dataDir);
  const key = cacheKey(fullName);
  const now = Date.now();
  const hit = cached(cache, key, now);
  if (hit !== undefined) return hit;

  const deadline = now + Math.max(1, timeoutMs);
  const ghResult = lookupWithGh(fullName, Math.max(1, deadline - Date.now()));
  const apiResult = ghResult ?? await lookupWithGitHubAPI(fullName, Math.max(1, deadline - Date.now()));
  const resolved = apiResult ?? null;
  saveGitHubRepositoryCache(dataDir, {
    entries: { ...cache.entries, [key]: { id: resolved, checkedAt: Date.now() } },
  });
  return resolved;
}
