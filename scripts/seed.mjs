#!/usr/bin/env node
/**
 * Load the seed exports for all three brands through the same pipeline as an
 * owner's in-app upload: file into the `imports` Storage bucket under the brand
 * folder, an `import_runs` row in the queue, the `process-imports` worker does
 * the rest. The one difference: no owner is signed in, so the service role
 * queues the run and `requested_by` stays empty.
 *
 * Order matters within a brand — campaigns and contacts before the events and
 * send log that reference them, the Kilele delta after its base file — and the
 * worker keeps queue order per brand.
 *
 * Running it twice loads every file twice; the second pass must report
 * 0 new customers (AC2.2).
 *
 * Usage: node scripts/seed.mjs   (reads SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF from .env.local)
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.local");
const env = { ...process.env, ...(existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}) };

const FILES = [
  ["KILELE", "kilele-campaigns.csv"],
  ["KILELE", "kilele-contacts.csv"],
  ["KILELE", "kilele-contacts-delta-2026-09-01.csv"],
  ["KILELE", "kilele-events.csv"],
  ["KILELE", "kilele-send-log.csv"],
  ["KAROO", "karoo-campaigns.csv"],
  ["KAROO", "karoo-contacts.csv"],
  ["KAROO", "karoo-events.csv"],
  ["MARRAKECH", "marrakech-campaigns.csv"],
  ["MARRAKECH", "marrakech-contacts.csv"],
  ["MARRAKECH", "marrakech-events.csv"],
];
const STALL_MS = 200_000;

const ref = env.SUPABASE_PROJECT_REF;
const keys = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
}).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`api-keys: ${r.status}`))));
// Edge Functions receive the new-style secret key, so the worker only recognises that one.
const serviceKey = (keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role"))?.api_key;
if (!serviceKey) throw new Error("No secret or service_role key found for the project.");

const url = `https://${ref}.supabase.co`;
// Realtime is never used here; the stub transport only lets supabase-js start on Node 20 (no native WebSocket).
const db = createClient(url, serviceKey, { auth: { persistSession: false }, realtime: { transport: class {} } });

const { data: brands, error: brandError } = await db.from("brands").select("id, code");
if (brandError) throw brandError;
const brandId = Object.fromEntries(brands.map((b) => [b.code, b.id]));

const runIds = [];
for (const [code, file] of FILES) {
  const storagePath = `${brandId[code]}/${randomUUID()}-${file}`;
  const body = readFileSync(path.join(root, "data", "seed", file));
  const { error: uploadError } = await db.storage.from("imports").upload(storagePath, body, { contentType: "text/csv" });
  if (uploadError) throw uploadError;
  const { data: run, error } = await db
    .from("import_runs")
    .insert({ brand_id: brandId[code], file_name: file, storage_path: storagePath })
    .select("id")
    .single();
  if (error) throw error;
  runIds.push(run.id);
  console.log(`queued run ${run.id}: ${code} ${file}`);
}

const kick = () =>
  fetch(`${url}/functions/v1/process-imports`, { method: "POST", headers: { Authorization: `Bearer ${serviceKey}` } });
// One chain per brand; the worker serialises runs within a brand.
await Promise.all(Object.keys(brandId).map(kick));

const columns = "id, file_name, kind, status, status_message, rows_total, rows_inserted, rows_updated, rows_unchanged, rows_rejected, rows_merged, rows_warned, byte_cursor, file_size";
let lastProgress = "";
let lastChange = Date.now();
let runs;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const { data, error } = await db.from("import_runs").select(columns).in("id", runIds).order("id");
  if (error) throw error;
  runs = data;
  const progress = runs.map((r) => `${r.status}:${r.byte_cursor}`).join(",");
  const open = runs.filter((r) => r.status === "queued" || r.status === "processing");
  if (open.length === 0) break;
  if (progress !== lastProgress) {
    lastProgress = progress;
    lastChange = Date.now();
    const bytes = runs.reduce((s, r) => s + Number(r.byte_cursor), 0);
    console.log(`${runs.length - open.length}/${runs.length} runs done, ${(bytes / 1e6).toFixed(1)} MB read`);
  } else if (Date.now() - lastChange > STALL_MS) {
    console.log("No progress for 200 s; triggering the worker again.");
    lastChange = Date.now();
    await Promise.all(Object.keys(brandId).map(kick));
  }
}

console.table(
  runs.map((r) => ({
    run: r.id, file: r.file_name, kind: r.kind, status: r.status, rows: r.rows_total, inserted: r.rows_inserted,
    updated: r.rows_updated, unchanged: r.rows_unchanged, rejected: r.rows_rejected, merged: r.rows_merged, warned: r.rows_warned,
  })),
);
for (const r of runs.filter((r) => r.status_message)) console.log(`run ${r.id} (${r.status}): ${r.status_message}`);
process.exit(runs.every((r) => r.status === "completed") ? 0 : 1);
