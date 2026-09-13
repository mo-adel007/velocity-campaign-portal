#!/usr/bin/env node
/**
 * Store what the pg_cron workers need in Supabase Vault: the project URL and
 * the server (`sb_secret_`) key the Edge Function workers accept. Run once per
 * project, and again after rotating the key. Nothing is written to the repo.
 *
 * Usage: node scripts/set-worker-secrets.mjs
 *   (reads SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF from .env.local)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.local");
const env = { ...process.env, ...(existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}) };
const ref = env.SUPABASE_PROJECT_REF;
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" };

const keys = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers }).then((r) =>
  r.ok ? r.json() : Promise.reject(new Error(`api-keys: ${r.status}`)),
);
const secretKey = keys.find((k) => k.type === "secret")?.api_key;
if (!secretKey) throw new Error("No sb_secret key found for the project.");

// Values travel as dollar-quoted literals through the Management API's SQL endpoint.
const literal = (v) => {
  if (v.includes("$v$")) throw new Error("Unexpected characters in secret.");
  return `$v$${v}$v$`;
};
const upsert = (name, value) => `
  select case
    when exists (select 1 from vault.secrets where name = '${name}')
    then (select vault.update_secret(id, ${literal(value)}) from vault.secrets where name = '${name}')::text
    else vault.create_secret(${literal(value)}, '${name}')::text
  end;`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers,
  body: JSON.stringify({ query: upsert("project_url", `https://${ref}.supabase.co`) + upsert("worker_secret_key", secretKey) }),
});
if (!res.ok) throw new Error(`database/query: ${res.status} ${await res.text()}`);
console.log("Vault secrets project_url and worker_secret_key are set.");
