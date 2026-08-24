import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, type CaptureEvent, type DropRecord } from "../src/outbox.js";

function event(index: number): CaptureEvent {
  return {
    captureEventId: `${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
    tool: "claude_code",
    kind: "UserPromptSubmit",
    externalSessionId: "s1",
    repo: "github.com/acme/widgets",
    repoCwd: ".",
    occurredAt: new Date(index).toISOString(),
    payload: { prompt: "x".repeat(220 * 1024) },
  };
}

test("the outbox evicts oldest events when its byte budget is full", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-outbox-capacity-"));
  for (let index = 0; index < 80; index++) appendEvent(dataDir, event(index));

  const files = readdirSync(join(dataDir, "outbox"));
  assert.ok(files.length > 0 && files.length < 80);
  assert.ok(files.some((file) => file.includes(event(79).captureEventId)));
  assert.ok(files.every((file) => !file.includes(event(0).captureEventId)));

  const status = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8")) as { drops: DropRecord[] };
  assert.ok(status.drops.some((drop) => drop.reason === "capacity"));
});
