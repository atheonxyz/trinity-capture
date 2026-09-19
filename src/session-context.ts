// The /trinity:task command: the same pull the hooks make, on demand at any
// point in a session, with whatever the person says they are working on.
import { claudeCodeDialect } from "./claude-hook.js";
import { loadConfig, loadPolicy } from "./config.js";
import { isPolicyFresh, resolveRoute } from "./gate.js";
import { resolveGitHubRepository } from "./github-repo.js";
import { isMainModule } from "./main-module.js";
import { currentBranch, gitRemoteOf } from "./observe.js";
import { fetchSessionContext, refreshPolicy, REQUEST_TIMEOUT_MS } from "./send.js";
import type { SessionContextCandidate } from "./send.js";

const LOOKUP_BUDGET_MS = 1_500;

export function describeCandidates(candidates: readonly SessionContextCandidate[]): string {
  if (candidates.length === 0) return "Trinity: no task matched this branch or what you said.";
  const lines = candidates.map((candidate) => {
    const key = candidate.key ? `${candidate.key} ` : "";
    const url = candidate.url ? `, ${candidate.url}` : "";
    return `- ${key}${candidate.title} (${candidate.status}${url}) via ${candidate.via}`;
  });
  return [
    "Trinity: tasks this session likely relates to:",
    ...lines,
    'If one of these is the task, say "trinity-task: <key>" once so Trinity tracks the session against it.',
  ].join("\n");
}

async function main(): Promise<void> {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? process.argv[3] };
  const dataDir = claudeCodeDialect.dataDir(env);
  const cfg = dataDir ? loadConfig(dataDir) : null;
  if (!dataDir || !cfg) {
    console.error("Trinity is not paired here. Run /trinity:connect <pairing-code> first.");
    process.exitCode = 1;
    return;
  }
  let policy = loadPolicy(dataDir);
  if (!isPolicyFresh(policy, Date.now())) {
    try {
      policy = await refreshPolicy(dataDir, cfg);
    } catch {
      policy = null;
    }
  }
  const cwd = process.cwd();
  const route = await resolveRoute(policy, gitRemoteOf(cwd), (fullName) => resolveGitHubRepository(dataDir, fullName, LOOKUP_BUDGET_MS));
  if (!route.send) {
    console.log("Trinity: this repository is not enabled for capture, so there is no task context to pull.");
    return;
  }
  const prompt = process.argv[2]?.trim() || undefined;
  try {
    const answer = await fetchSessionContext(cfg, { repo: route.canonicalRepo, branch: currentBranch(cwd) ?? "", prompt }, REQUEST_TIMEOUT_MS);
    console.log(describeCandidates(answer?.candidates ?? []));
  } catch (err) {
    console.error(`Trinity could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
