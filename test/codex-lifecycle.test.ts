import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { codexDialect } from "../src/codex-hook.js";

test("Codex SessionEnd is append-only and synchronous", () => {
  assert.equal(codexDialect.drainsOn("SessionEnd"), false);
  const manifest: unknown = JSON.parse(readFileSync(join(process.cwd(), "codex", "hooks", "hooks.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("hooks" in manifest)) {
    assert.fail("hooks manifest is missing hooks");
  }
  const hooks = manifest.hooks;
  if (typeof hooks !== "object" || hooks === null || !("SessionEnd" in hooks) || !Array.isArray(hooks.SessionEnd)) {
    assert.fail("hooks manifest is missing SessionEnd");
  }
  const group = hooks.SessionEnd[0];
  if (typeof group !== "object" || group === null || !("hooks" in group) || !Array.isArray(group.hooks)) {
    assert.fail("SessionEnd has no hook command");
  }
  const command = group.hooks[0];
  if (typeof command !== "object" || command === null) assert.fail("SessionEnd command is missing");
  assert.notEqual("async" in command ? command.async : undefined, true);
});
