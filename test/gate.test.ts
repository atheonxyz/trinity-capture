import test from "node:test";
import assert from "node:assert/strict";
import { routeFor } from "../src/gate.js";
import type { Policy } from "../src/config.js";

function freshPolicy(workspaces: Policy["workspaces"]): Policy {
  return { etag: "x", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces };
}

test("expired policy fails closed", () => {
  const p: Policy = {
    etag: "x",
    fetchedAt: 0,
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/a/r", aliases: [], route: "project:p1" }],
  };
  assert.deepEqual(routeFor(p, Date.now(), "git@github.com:a/r.git"), { send: false });
});

test("personal repo never matches", () => {
  const p = freshPolicy([{ canonicalRepo: "github.com/a/r", aliases: [], route: "project:p1" }]);
  assert.deepEqual(routeFor(p, Date.now(), "https://github.com/me/personal"), { send: false });
});

test("alias forms normalize to a match", () => {
  const p = freshPolicy([{ canonicalRepo: "github.com/a/r", aliases: [], route: "project:p1" }]);
  for (const remote of ["git@github.com:a/r.git", "https://github.com/A/R", "ssh://git@github.com/a/r"])
    assert.equal(routeFor(p, Date.now(), remote).send, true, remote);
});

test("null policy fails closed", () => {
  assert.deepEqual(routeFor(null, Date.now(), "git@github.com:a/r.git"), { send: false });
});

test("null git remote fails closed", () => {
  const p = freshPolicy([{ canonicalRepo: "github.com/a/r", aliases: [], route: "project:p1" }]);
  assert.deepEqual(routeFor(p, Date.now(), null), { send: false });
});

test("a repo routed ambiguous or disabled never sends", () => {
  const p = freshPolicy([
    { canonicalRepo: "github.com/a/ambiguous", aliases: [], route: "ambiguous" },
    { canonicalRepo: "github.com/a/disabled", aliases: [], route: "disabled" },
  ]);
  assert.deepEqual(routeFor(p, Date.now(), "git@github.com:a/ambiguous.git"), { send: false });
  assert.deepEqual(routeFor(p, Date.now(), "git@github.com:a/disabled.git"), { send: false });
});

test("a server-provided alias distinct from the canonical form matches", () => {
  const p = freshPolicy([
    { canonicalRepo: "github.com/a/r", aliases: ["github.example.com/a/r-renamed"], route: "project:p1" },
  ]);
  const result = routeFor(p, Date.now(), "git@github.example.com:a/r-renamed.git");
  assert.equal(result.send, true);
  if (result.send) assert.equal(result.canonicalRepo, "github.com/a/r");
});
