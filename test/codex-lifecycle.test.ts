import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { codexDialect } from "../src/codex-hook.js";

test("Codex hooks use bounded synchronous lifecycle drains", () => {
  assert.equal(codexDialect.drainInline, true);
  assert.equal(codexDialect.drainsOn("SessionStart"), false);
  assert.equal(codexDialect.drainsOn("PostToolUse"), false);
  assert.equal(codexDialect.drainsOn("Stop"), true);
  assert.equal(codexDialect.drainsOn("SessionEnd"), true);

  const manifest: unknown = JSON.parse(readFileSync(join(process.cwd(), "codex", "hooks", "hooks.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("hooks" in manifest)) {
    assert.fail("hooks manifest is missing hooks");
  }
  const hooks = manifest.hooks;
  if (typeof hooks !== "object" || hooks === null) assert.fail("hooks manifest is malformed");
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) assert.fail("hook event is not an array");
    for (const group of groups) {
      if (typeof group !== "object" || group === null || !("hooks" in group) || !Array.isArray(group.hooks)) {
        assert.fail("hook event has no commands");
      }
      for (const command of group.hooks) {
        if (typeof command !== "object" || command === null) assert.fail("hook command is missing");
        assert.notEqual("async" in command ? command.async : undefined, true);
      }
    }
  }
});
