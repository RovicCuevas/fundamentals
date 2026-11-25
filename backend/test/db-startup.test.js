import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("configured Supabase connection failure does not create a SQLite database", () => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "smartcare-db-startup-"));
  const dbPath = path.join(tempDirectory, "smartcare.db");
  const appUrl = pathToFileURL(path.join(backendDirectory, "src", "app.js")).href;
  const script = `
    process.loadEnvFile = () => {};
    const { createApp } = await import(${JSON.stringify(appUrl)});
    try {
      const instance = createApp({
        dbPath: ${JSON.stringify(dbPath)},
        supabaseDbUrl: "postgresql://test:test@127.0.0.1:1/test",
        jwtSecret: "t".repeat(40),
        faceDescriptorKey: "a".repeat(64),
        notificationProvider: "console",
        seedOnStart: false,
      });
      await instance.close();
      console.log("STARTED_WITH_FALLBACK");
    } catch (error) {
      console.error("SUPABASE_CONNECT_ERROR:" + (error.code || error.message));
      process.exitCode = 23;
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: backendDirectory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
      timeout: 15_000,
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 23, result.stdout || result.stderr);
    assert.match(result.stderr, /SUPABASE_CONNECT_ERROR:ECONNREFUSED/);
    assert.equal(existsSync(dbPath), false, "SQLite must not be created when Supabase is configured");
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
