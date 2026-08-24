// Fail closed (spec §4.2): the caller must be able to trust a `send: false`
// answer without inspecting why.
import type { Policy } from "./config.js";

export function routeFor(
  policy: Policy | null,
  now: number,
  gitRemote: string | null,
): { send: false } | { send: true; canonicalRepo: string; route: string } {
  if (!policy) return { send: false };
  if (now > policy.fetchedAt + policy.ttlSeconds * 1000) return { send: false };
  if (!gitRemote) return { send: false };

  const normalized = normalizeRemote(gitRemote);
  for (const ws of policy.workspaces) {
    const candidates = [ws.canonicalRepo, ...ws.aliases].map(normalizeRemote);
    if (!candidates.includes(normalized)) continue;
    if (!ws.route.startsWith("project:")) return { send: false };
    return { send: true, canonicalRepo: ws.canonicalRepo, route: ws.route };
  }
  return { send: false };
}

function normalizeRemote(remote: string): string {
  let s = remote.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  s = s.replace(/^git@([^/:]+):/, "$1/"); // git@host:path -> host/path
  s = s.replace(/^git@/, ""); // git@host/path (scheme already stripped) -> host/path
  s = s.replace(/\.git$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}
