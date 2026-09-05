import test from "node:test";
import assert from "node:assert/strict";
import {
  MachineIdentityError,
  machineIdFromRawIdentifier,
} from "../src/machine-identity.js";

const MAC_UUID = "A1B2C3D4-E5F6-4789-8ABC-0123456789AB";
const LINUX_ID = "0123456789abcdef0123456789abcdef";

test("derives a deterministic lowercase machine id for each supported platform", () => {
  assert.equal(
    machineIdFromRawIdentifier("darwin", MAC_UUID),
    "ae00cdad3c16201065c4654c999d797a10328bbbb163bb383004ea5c966224c2",
  );
  assert.equal(
    machineIdFromRawIdentifier("win32", MAC_UUID),
    "2d25ded655025b4c740b044f1bc0c259bbd5a420b8844357e3ca6fec2836405b",
  );
  assert.equal(
    machineIdFromRawIdentifier("linux", LINUX_ID),
    "97564b7ddc4904a93df555b581e21d0a1b2f7bb9b4033ae1de54a1ecc737b308",
  );
});

test("different raw OS identifiers produce different machine ids", () => {
  const first = machineIdFromRawIdentifier("linux", LINUX_ID);
  const second = machineIdFromRawIdentifier("linux", "fedcba9876543210fedcba9876543210");

  assert.notEqual(first, second);
});

test("canonicalizes GUID based identities before deriving the digest", () => {
  assert.equal(
    machineIdFromRawIdentifier("darwin", "a1b2c3d4-e5f6-4789-8abc-0123456789ab"),
    machineIdFromRawIdentifier("darwin", MAC_UUID),
  );
  assert.equal(machineIdFromRawIdentifier("win32", `${MAC_UUID}\r\n`), machineIdFromRawIdentifier("win32", MAC_UUID));
});

test("rejects missing malformed and reserved identifiers", () => {
  for (const raw of ["", ` ${MAC_UUID}`, "not-a-machine-id", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    assert.throws(
      () => machineIdFromRawIdentifier("darwin", raw),
      (error: unknown) => error instanceof MachineIdentityError && error.reason === "machine_identity_invalid",
    );
  }
  assert.throws(
    () => machineIdFromRawIdentifier("linux", "0123456789ABCDEF0123456789ABCDEF"),
    (error: unknown) => error instanceof MachineIdentityError && error.reason === "machine_identity_invalid",
  );
});

test("rejects unsupported platforms without falling back to a generated id", () => {
  assert.throws(
    () => machineIdFromRawIdentifier("freebsd", LINUX_ID),
    (error: unknown) => error instanceof MachineIdentityError && error.reason === "unsupported_platform",
  );
});
