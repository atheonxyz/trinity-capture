import type { Policy } from "./config.js";

type CaptureRoute = { send: false } | { send: true; canonicalRepo: string };

export function isPolicyFresh(policy: Policy | null, now: number): policy is Policy {
  return policy !== null && now <= policy.fetchedAt + policy.ttlSeconds * 1000;
}

export function matchRoute(policy: Policy | null, gitRemote: string | null): CaptureRoute {
  if (!policy || !gitRemote) return { send: false };

  const normalized = normalizeRemote(gitRemote);
  for (const workspace of policy.workspaces) {
    const candidates = [workspace.canonicalRepo, ...workspace.aliases].map(normalizeRemote);
    if (!candidates.includes(normalized)) continue;
    if (!workspace.route.startsWith("project:")) return { send: false };
    return { send: true, canonicalRepo: workspace.canonicalRepo };
  }
  return { send: false };
}

export function routeFor(
  policy: Policy | null,
  now: number,
  gitRemote: string | null,
): CaptureRoute {
  return isPolicyFresh(policy, now) ? matchRoute(policy, gitRemote) : { send: false };
}

function normalizeRemote(remote: string): string {
  let s = remote.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^git@([^/:]+):/, "$1/");
  s = s.replace(/^git@/, "");
  s = s.replace(/\.git$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}
