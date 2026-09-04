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

export async function resolveRoute(
  policy: Policy | null,
  gitRemote: string | null,
  lookup: (fullName: string) => Promise<number | null>,
): Promise<CaptureRoute> {
  if (!isPolicyFresh(policy, Date.now()) || !gitRemote) return { send: false };
  const normalized = normalizeRemote(gitRemote);
  if (policy.workspaces.some((workspace) =>
    [workspace.canonicalRepo, ...workspace.aliases].some((candidate) => normalizeRemote(candidate) === normalized))) {
    return matchRoute(policy, gitRemote);
  }
  const match = /^github\.com\/([a-z0-9-]+\/[a-z0-9_.-]+)$/.exec(normalized);
  const fullName = match?.[1];
  if (!fullName || /\/(?:\.|\.\.)$/.test(fullName)) return { send: false };
  if (!policy.workspaces.some((workspace) => workspace.githubRepositoryId && workspace.route.startsWith("project:"))) {
    return { send: false };
  }
  const id = await lookup(fullName);
  if (id === null || !isPolicyFresh(policy, Date.now())) return { send: false };
  const matches = policy.workspaces.filter((workspace) => workspace.githubRepositoryId === id);
  const workspace = matches.length === 1 ? matches[0] : undefined;
  return workspace?.route.startsWith("project:")
    ? { send: true, canonicalRepo: workspace.canonicalRepo }
    : { send: false };
}

function normalizeRemote(remote: string): string {
  let s = remote.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^git@([^/:]+):/, "$1/");
  s = s.replace(/^git@/, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/, "");
  return s;
}
