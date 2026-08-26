// Spawned as a real, separate OS process by hook-core.test.ts to exercise
// claimTurnKey's exclusive-create race across genuinely concurrent
// processes — an in-process Promise.all of two synchronous calls can't
// interleave at all, so it would prove nothing about the race this file
// exists to check. Prints the resolved key to stdout with no trailing
// newline.
import { claimTurnKey } from "../../src/hook-core.js";

const [sessionDir, vendorTurnId] = process.argv.slice(2);
if (!sessionDir || vendorTurnId === undefined) {
  console.error("usage: turnkey-race-worker.js <sessionDir> <vendorTurnId>");
  process.exit(1);
}
process.stdout.write(claimTurnKey(sessionDir, vendorTurnId));
