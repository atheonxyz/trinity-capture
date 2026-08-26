import assert from "node:assert/strict";
import test from "node:test";
import { supportsNodeVersion } from "../src/connect.js";

test("connect accepts only supported Node major versions", () => {
  assert.equal(supportsNodeVersion("19.9.0"), false);
  assert.equal(supportsNodeVersion("20.0.0"), true);
  assert.equal(supportsNodeVersion("26.1.0"), true);
  assert.equal(supportsNodeVersion("invalid"), false);
});
