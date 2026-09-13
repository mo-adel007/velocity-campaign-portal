#!/usr/bin/env node
/**
 * Run a local CLI with `.env.local` loaded, without going through npm's shell shims.
 *
 * Why: on Windows, npm/npx `.cmd` shims break when the repo path contains `&`
 * (cmd.exe splits the command). Spawning `node <package entry>` directly avoids
 * the shell entirely.
 *
 * Usage: node scripts/env-run.mjs <supabase|vitest|next|vercel> [...args]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(root, ".env.local");
const env = { ...process.env };
if (existsSync(envFile)) Object.assign(env, dotenv.parse(readFileSync(envFile)));

const entries = {
  supabase: () => path.join(path.dirname(require.resolve("supabase/package.json")), "dist", "supabase.js"),
  vitest: () => path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
  next: () => path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next"),
  vercel: () => path.join(path.dirname(require.resolve("vercel/package.json")), "dist", "vc.js"),
};

const [tool, ...args] = process.argv.slice(2);
if (!entries[tool]) {
  console.error(`Unknown tool "${tool}". Use one of: ${Object.keys(entries).join(", ")}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [entries[tool](), ...args], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
