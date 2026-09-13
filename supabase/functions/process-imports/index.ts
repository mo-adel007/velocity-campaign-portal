/**
 * process-imports: the loader worker for every queued import run.
 *
 * Each invocation claims the oldest claimable run (one run per brand at a
 * time), reads the next ~1 MB byte range of its file from Storage, validates
 * the complete lines with the shared brand-aware parser, and commits the range
 * through `yield_import_run` in one transaction. It then invokes itself for the
 * next range, so a 22 MB file stays inside the ~2 s CPU limit per call.
 *
 * It answers 202 at once and works in the background, so the self-invocation
 * chain never nests. If a worker dies mid-range, the run's lock expires after
 * 3 minutes and the next trigger (seed script or cron) retries that range.
 *
 * Only callable with a server key (service_role or sb_secret); data never
 * reaches the browser.
 */
import { createClient } from "@supabase/supabase-js";
import {
  dominantForeignBrand,
  parseHeader,
  prepareRecords,
  readChunk,
  validateLines,
  type Encoding,
} from "../_shared/ingest.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const CHUNK_BYTES = Number(Deno.env.get("IMPORT_CHUNK_BYTES") ?? 1024 * 1024);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Projects carry both the legacy service_role JWT and new `sb_secret_` keys; either may call.
const SERVER_KEYS = new Set(
  [SERVICE_KEY, ...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))].filter(Boolean),
);

interface ImportRun {
  id: number;
  brand_id: string;
  storage_path: string;
  byte_cursor: number;
  cursor_row: number;
  header_line: string | null;
  encoding: Encoding | null;
  started_at: string;
}

Deno.serve((req) => {
  if (!SERVER_KEYS.has(req.headers.get("Authorization")?.replace(/^Bearer /, ""))) {
    return new Response("Forbidden", { status: 403 });
  }
  EdgeRuntime.waitUntil(work());
  return Response.json({ accepted: true }, { status: 202 });
});

async function work() {
  const { data: run, error } = await db.rpc("claim_import_run");
  if (error) return console.error("claim_import_run failed:", error.message);
  if (!run?.id) return;

  try {
    await processRange(run as ImportRun);
  } catch (e) {
    // Leave the lock in place: it expires and the range is retried (3 attempts).
    return console.error(`Import run ${run.id} at byte ${run.byte_cursor}:`, e instanceof Error ? e.message : e);
  }

  await fetch(`${SUPABASE_URL}/functions/v1/process-imports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

async function processRange(run: ImportRun) {
  const start = run.byte_cursor;
  const objectPath = run.storage_path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/imports/${objectPath}`, {
    // An `sb_secret_` key is not a JWT: without `apikey` Storage treats the call as anon ("Bucket not found").
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Range: `bytes=${start}-${start + CHUNK_BYTES - 1}` },
  });
  if (!res.ok) throw new Error(`Storage returned ${res.status}: ${await res.text()}`);

  let bytes = new Uint8Array(await res.arrayBuffer());
  let fileSize: number;
  if (res.status === 206) {
    fileSize = Number(res.headers.get("Content-Range")?.split("/")[1]);
  } else {
    fileSize = bytes.length;
    bytes = bytes.subarray(start, start + CHUNK_BYTES);
  }
  const atEof = start + bytes.length >= fileSize;

  const stop = (message: string) =>
    start === 0
      ? finish(run.id, "refused", `${message} Nothing was stored.`)
      : finish(run.id, "failed", `Stopped at row ${run.cursor_row + 1}: ${message} Rows before that point were loaded.`);

  const chunk = readChunk(bytes, atEof, run.encoding);
  if (!chunk) return stop(`A line is longer than ${Math.round(CHUNK_BYTES / 1024)} KB, so the file cannot be read.`);

  const lines = chunk.lines;
  const headerLine = start === 0 ? lines.shift() : run.header_line;
  if (!headerLine) return stop("The file is empty.");
  const head = parseHeader(headerLine);
  if (!head.ok) return stop(head.message);

  const { data: brand, error: brandError } = await db.from("brands").select("code, timezone").eq("id", run.brand_id).single();
  if (brandError) throw new Error(brandError.message);

  if (start === 0) {
    const foreign = dominantForeignBrand(head.header, lines, brand.code);
    if (foreign) return stop(`Most rows in this file belong to brand ${foreign}, not ${brand.code}.`);
  }

  // One fixed "now" per run, so a future-date rule gives the same answer in every range.
  const validated = validateLines(head.header, lines, run.cursor_row + 1, {
    brandCode: brand.code,
    timeZone: brand.timezone,
    now: new Date(run.started_at),
  });
  const prepared = await prepareRecords(head.header.kind, validated.records);

  const { error } = await db.rpc("yield_import_run", {
    p_run_id: run.id,
    p_expected_cursor: start,
    p_next_cursor: start + chunk.consumed,
    p_rows: lines.length,
    p_merged: validated.records.length - prepared.records.length,
    p_kind: head.header.kind,
    p_header_line: headerLine,
    p_encoding: chunk.encoding,
    p_file_size: fileSize,
    p_records: prepared.records,
    p_issues: [...validated.issues, ...prepared.issues],
    p_done: atEof,
  });
  if (error) throw new Error(`yield_import_run: ${error.message}`);
}

async function finish(runId: number, status: "refused" | "failed", message: string) {
  const { error } = await db.rpc("finish_import_run", { p_run_id: runId, p_status: status, p_message: message });
  if (error) throw new Error(`finish_import_run: ${error.message}`);
}
