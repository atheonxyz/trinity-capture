import test from "node:test";
import assert from "node:assert/strict";
import type { Policy } from "../src/config.js";
import { resolveRoute } from "../src/gate.js";

function policy(route = "project:one"): Policy {
  return {
    etag: "selected-repos", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/team/new", githubRepositoryId: 42, aliases: [], route }],
  };
}

test("a renamed GitHub origin routes only by the selected immutable ID", async () => {
  const lookedUp: string[] = [];
  const route = await resolveRoute(policy(), "git@github.com:team/old.git", async (name) => {
    lookedUp.push(name);
    return 42;
  });
  assert.deepEqual(lookedUp, ["team/old"]);
  assert.deepEqual(route, { send: true, canonicalRepo: "github.com/team/new" });
});

test("a reused old repository name never inherits the selected repository route", async () => {
  assert.deepEqual(await resolveRoute(policy(), "https://github.com/team/old.git", async () => 99), { send: false });
});

test("personal repositories and failed GitHub lookups never match", async () => {
  for (const id of [99, null]) {
    assert.deepEqual(await resolveRoute(policy(), "https://github.com/person/private", async () => id), { send: false });
  }
});

test("known origins and blocked routes need no external identity lookup", async () => {
  for (const route of ["project:one", "disabled", "ambiguous"]) {
    let calls = 0;
    const result = await resolveRoute(policy(route), "https://github.com/team/new", async () => { calls++; return 42; });
    assert.equal(calls, 0);
    assert.equal(result.send, route === "project:one");
  }
});

test("stale policy, missing IDs, and non-GitHub remotes never trigger a lookup", async () => {
  const old = policy();
  old.fetchedAt = 0;
  const legacy = policy();
  delete legacy.workspaces[0]?.githubRepositoryId;
  for (const [doc, remote] of [
    [old, "git@github.com:team/old.git"],
    [legacy, "git@github.com:team/old.git"],
    [policy(), "https://github.com.evil.test/team/old"],
    [policy(), "/local/private"],
    [policy(), "https://github.com/team/../personal"],
  ] as const) {
    let calls = 0;
    assert.deepEqual(await resolveRoute(doc, remote, async () => { calls++; return 42; }), { send: false });
    assert.equal(calls, 0);
  }
});

test("policy expiry during lookup still fails closed", async () => {
  const doc = policy();
  assert.deepEqual(await resolveRoute(doc, "https://github.com/team/old", async () => {
    doc.fetchedAt = 0;
    return 42;
  }), { send: false });
});

test("ambiguous immutable identity fails closed", async () => {
  const doc = policy();
  doc.workspaces.push({ canonicalRepo: "github.com/team/other", githubRepositoryId: 42, aliases: [], route: "project:two" });
  assert.deepEqual(await resolveRoute(doc, "https://github.com/team/old", async () => 42), { send: false });
});
