import assert from "node:assert/strict";
import test from "node:test";
import { validateAdminInput } from "../scripts/create-admin.js";
import { seedIfEmpty } from "../src/seed.js";

test("create-admin validates a minimum-length password and normalizes email", () => {
  assert.deepEqual(
    validateAdminInput({ email: " Admin@Example.com ", password: "a".repeat(12), adminCount: 0 }),
    { email: "admin@example.com", password: "a".repeat(12) },
  );
  assert.throws(
    () => validateAdminInput({ email: "admin@example.com", password: "short", adminCount: 0 }),
    /at least 12 characters/,
  );
});

test("create-admin refuses an existing admin unless forced", () => {
  assert.throws(
    () => validateAdminInput({ email: "admin@example.com", password: "a".repeat(12), adminCount: 1 }),
    /already exists/,
  );
  assert.doesNotThrow(
    () => validateAdminInput({ email: "admin@example.com", password: "a".repeat(12), adminCount: 1, force: true }),
  );
});

test("seedIfEmpty refuses production seeding", () => {
  assert.throws(
    () => seedIfEmpty({ config: { isProd: true }, db: { prepare() { throw new Error("database should not be queried"); } } }),
    /disabled when NODE_ENV=production/,
  );
});
