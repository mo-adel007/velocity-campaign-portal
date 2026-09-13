/**
 * Brand-aware CSV parsing and row validation for every export we accept.
 *
 * Pure TypeScript with no runtime-specific imports, so the same code runs in
 * the `process-imports` Edge Function (Deno) and in the Vitest suite (Node).
 *
 * What this module decides — and the SQL ingest functions then store:
 *   - which kind of file this is (contacts / campaigns / events / send log),
 *     from its header, whatever the column names, order, case or delimiter;
 *   - which rows are rejected (not stored) and why;
 *   - which rows are stored with a warning (e.g. invalid email kept as NULL,
 *     country normalised to ISO-2), so the marketer can see every change.
 *
 * Files arrive in byte-range chunks (Edge Function CPU limits), so parsing is
 * line-based: `readChunk` cuts a byte range at its last newline.
 */
import Papa from "papaparse";

export type ImportKind = "contacts" | "campaigns" | "events" | "send_log";
export type Severity = "rejected" | "warning";

export interface Issue {
  row_number: number | null;
  severity: Severity;
  reason_code: string;
  message: string;
  raw: string | null;
}

export interface HeaderInfo {
  kind: ImportKind;
  delimiter: string;
  columns: Record<string, number>;
  width: number;
}

export interface ValidationContext {
  brandCode: string;
  /** IANA zone of the brand; zone-less day/month/year dates are read in it. */
  timeZone: string;
  now: Date;
}

// ---------------------------------------------------------------------------
// Decoding and splitting
// ---------------------------------------------------------------------------

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (Karoo's export). */
export function decodeBytes(bytes: Uint8Array, encoding?: Encoding) {
  if (encoding) {
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" as const };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" as const };
  }
}

/** Index just past the last "\n" byte, or -1. Cutting here never splits a UTF-8 character. */
export function lastNewlineEnd(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) return i + 1;
  }
  return -1;
}

export function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

export type Encoding = "utf-8" | "windows-1252";

/**
 * Take the complete lines from one byte range of a file. A range that is not
 * the file's end is cut after its last newline; `consumed` is where the next
 * range starts. Returns null when a non-final range holds no newline at all.
 *
 * The encoding is decided by the first range containing a non-ASCII byte and
 * then kept for the rest of the file (ASCII reads the same either way), so a
 * cp1252 file whose first megabyte happens to be plain ASCII is still decoded
 * as cp1252 later on.
 */
export function readChunk(bytes: Uint8Array, atEof: boolean, encoding: Encoding | null) {
  const end = atEof ? bytes.length : lastNewlineEnd(bytes);
  if (end === -1) return null;
  const body = bytes.subarray(0, end);
  let decided = encoding;
  if (!decided && body.some((b) => b >= 0x80)) decided = decodeBytes(body).encoding;
  const text = new TextDecoder(decided ?? "utf-8").decode(body);
  return { consumed: end, encoding: decided, lines: splitLines(stripBom(text)) };
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Canonical column -> accepted spellings (already normalised). */
const ALIASES: Record<string, string[]> = {
  external_id: ["externalid", "id", "customerid", "contactid"],
  full_name: ["fullname", "name", "nom"],
  email: ["email", "emailaddress"],
  phone: ["phone", "mobile", "telephone", "tel"],
  country: ["country", "pays"],
  city: ["city", "ville"],
  signup_at: ["signupat", "signupdate", "signedupat"],
  status: ["status", "statut"],
  consent_marketing: ["consentmarketing", "marketingconsent"],
  deleted_at: ["deletedat"],
  suppressed_until: ["suppresseduntil"],
  brand_code: ["brandcode", "brand"],
  notes: ["notes", "note"],
  campaign_name: ["campaignname"],
  channel: ["channel"],
  target_country: ["targetcountry"],
  reported_sent: ["reportedsent"],
  reported_delivered: ["reporteddelivered"],
  reported_bounced: ["reportedbounced"],
  reported_opens: ["reportedopens"],
  reported_clicks: ["reportedclicks"],
  spend: ["spend"],
  sent_at: ["sentatutc", "sentat"],
  send_local_time: ["sendlocaltime"],
  parent_campaign_id: ["parentcampaignid"],
  event_id: ["eventid"],
  external_contact_id: ["externalcontactid"],
  campaign_external_id: ["campaignexternalid"],
  event_type: ["eventtype", "type"],
  occurred_at: ["occurredatutc", "occurredat"],
  batch_key: ["batchkey"],
  queued_at: ["queuedatutc", "queuedat"],
  recipient_count: ["recipientcount"],
};

const REQUIRED: Record<ImportKind, string[]> = {
  contacts: ["external_id", "email", "signup_at", "status", "consent_marketing"],
  campaigns: ["external_id", "campaign_name", "channel"],
  events: ["event_id", "external_contact_id", "campaign_external_id", "event_type", "channel", "occurred_at"],
  send_log: ["batch_key", "campaign_external_id", "queued_at", "recipient_count"],
};

export function detectDelimiter(headerLine: string) {
  const counts = [",", ";", "\t"].map((d) => [d, headerLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export type HeaderResult = { ok: true; header: HeaderInfo } | { ok: false; message: string };

export function parseHeader(headerLine: string): HeaderResult {
  const line = stripBom(headerLine);
  const delimiter = detectDelimiter(line);
  const names = parseDelimited(line, delimiter)[0] ?? [];
  if (names.length < 2) {
    return { ok: false, message: "This does not look like a CSV export: no header row with column names was found." };
  }

  const columns: Record<string, number> = {};
  names.forEach((name, index) => {
    const n = normalizeName(name);
    for (const [canonical, spellings] of Object.entries(ALIASES)) {
      if (!(canonical in columns) && spellings.includes(n)) {
        columns[canonical] = index;
        break;
      }
    }
  });

  // Most specific kinds first: events and send logs also carry campaign ids.
  const order: ImportKind[] = ["events", "send_log", "campaigns", "contacts"];
  for (const kind of order) {
    if (REQUIRED[kind].every((c) => c in columns)) {
      return { ok: true, header: { kind, delimiter, columns, width: names.length } };
    }
  }

  const best = order
    .map((kind) => ({ kind, missing: REQUIRED[kind].filter((c) => !(c in columns)) }))
    .sort((a, b) => a.missing.length - b.missing.length)[0];
  return {
    ok: false,
    message: `Unrecognised file. Closest match is a ${best.kind.replace("_", " ")} export, but these required columns are missing: ${best.missing.join(", ")}.`,
  };
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  const result = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: true });
  return result.data;
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

const NULL_TOKENS = new Set(["", "null", "none", "n/a", "na", "-", "\\n", "undefined", "nil"]);
const isBlank = (v: string | undefined) => v === undefined || NULL_TOKENS.has(v.trim().toLowerCase());

const COUNTRY_ALIASES: Record<string, string> = {
  ken: "KE", "254": "KE", kenya: "KE",
  zaf: "ZA", "27": "ZA", "south africa": "ZA", southafrica: "ZA",
  mar: "MA", "212": "MA", morocco: "MA", maroc: "MA",
  uga: "UG", "256": "UG", uganda: "UG",
  tza: "TZ", "255": "TZ", tanzania: "TZ",
  rwa: "RW", "250": "RW", rwanda: "RW",
  eth: "ET", "251": "ET", ethiopia: "ET",
  ssd: "SS", "211": "SS", "south sudan": "SS",
};
// ISO-2 codes we accept as-is. "ZZ" is the ISO user-assigned "unknown" code.
const KNOWN_ISO2 = new Set(["KE", "ZA", "MA", "UG", "TZ", "RW", "ET", "SS", "NG", "GH", "EG", "TN", "DZ", "AE", "SA", "GB", "US", "FR", "ES"]);

export function normalizeCountry(value: string | undefined): { code: string | null; note?: string } {
  if (isBlank(value)) return { code: null };
  const raw = value!.trim();
  const upper = raw.toUpperCase();
  if (upper.length === 2 && KNOWN_ISO2.has(upper)) {
    return upper === raw ? { code: upper } : { code: upper, note: `country "${raw}" normalised to ${upper}` };
  }
  const alias = COUNTRY_ALIASES[raw.toLowerCase()];
  if (alias) return { code: alias, note: `country "${raw}" normalised to ${alias}` };
  return { code: null, note: `country "${raw}" is not recognised; stored as unknown` };
}

const TRUE_TOKENS = new Set(["true", "1", "yes", "y", "t"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "n", "f"]);

export function normalizeConsent(value: string | undefined): { value: boolean; note?: string } {
  const v = (value ?? "").trim().toLowerCase();
  if (TRUE_TOKENS.has(v)) return { value: true };
  if (FALSE_TOKENS.has(v) || v === "") return { value: false };
  return { value: false, note: `consent value "${value}" not recognised; treated as no consent` };
}

const STATUS_MAP: Record<string, string> = {
  active: "active",
  pending: "pending",
  unsubscribed: "unsubscribed",
  unsubscribe: "unsubscribed",
  bounced: "bounced",
  bounce: "bounced",
};

export function normalizeStatus(value: string | undefined): string | null {
  return STATUS_MAP[(value ?? "").trim().toLowerCase()] ?? null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string | undefined): { email: string | null; invalid: boolean } {
  if (isBlank(value)) return { email: null, invalid: false };
  const email = value!.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? { email, invalid: false } : { email: null, invalid: true };
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** Strict ISO-8601 timestamp; date-only and zone-less values are read as UTC. */
export function parseTimestamp(value: string | undefined): { iso: string | null; invalid: boolean } {
  if (isBlank(value)) return { iso: null, invalid: false };
  let v = value!.trim();
  if (!ISO_DATETIME_RE.test(v)) return { iso: null, invalid: true };
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(v)) v = v.length === 10 ? `${v}T00:00:00Z` : `${v.replace(" ", "T")}Z`;
  // Trim sub-millisecond precision, which Date cannot parse reliably.
  v = v.replace(/(\.\d{3})\d+/, "$1");
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? { iso: null, invalid: true } : { iso: d.toISOString(), invalid: false };
}

const DMY_DATETIME_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;

/**
 * Kilele's export writes some signups as "DD/MM/YYYY HH:MM" with no zone
 * (day first: days above 12 occur, months above 12 never do). Read as wall
 * time in the brand's zone. Anything else goes through strict ISO parsing.
 */
export function parseLocalOrIsoTimestamp(value: string | undefined, timeZone: string) {
  const m = value?.trim().match(DMY_DATETIME_RE);
  if (!m) return { ...parseTimestamp(value), local: false };
  const [day, month, year, hour, minute] = m.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1 || hour > 23 || minute > 59) {
    return { iso: null, invalid: true, local: false };
  }
  // Offset of the zone at that moment: format the instant in the zone, compare to the wall time.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(check).map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return { iso: new Date(wall - (shown - wall)).toISOString(), invalid: false, local: true };
}

export function parseCount(value: string | undefined): { n: number | null; invalid: boolean } {
  if (isBlank(value)) return { n: null, invalid: false };
  const v = value!.trim();
  return /^\d+$/.test(v) && Number(v) <= 2_000_000_000 ? { n: Number(v), invalid: false } : { n: null, invalid: true };
}

/** Accepts "221.09" and the Marrakech decimal-comma form "221,09". */
export function parseMoney(value: string | undefined): { n: number | null; invalid: boolean } {
  if (isBlank(value)) return { n: null, invalid: false };
  let v = value!.trim().replace(/\s/g, "");
  if (/^\d+,\d{1,2}$/.test(v)) v = v.replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(v) ? { n: Number(v), invalid: false } : { n: null, invalid: true };
}

const EVENT_TYPES: Record<string, string> = {
  delivered: "delivered", delivery: "delivered",
  open: "open", opened: "open",
  click: "click", clicked: "click",
  bounce: "bounce", bounced: "bounce",
  unsubscribe: "unsubscribe", unsubscribed: "unsubscribe",
  complaint: "complaint", complained: "complaint", spam: "complaint",
};

export const normalizeEventType = (value: string | undefined) => EVENT_TYPES[(value ?? "").trim().toLowerCase()] ?? null;

const normalizeChannel = (value: string | undefined) => {
  const v = (value ?? "").trim().toLowerCase();
  return v === "email" || v === "sms" ? v : null;
};

const text = (value: string | undefined, max: number) => (isBlank(value) ? null : value!.trim().slice(0, max));

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

export type RowResult = { record: Record<string, unknown> | null; issues: Issue[] };

export function validateRow(
  header: HeaderInfo,
  fields: string[],
  rowNumber: number,
  rawLine: string,
  ctx: ValidationContext,
): RowResult {
  const issues: Issue[] = [];
  const reject = (reason_code: string, message: string): RowResult => ({
    record: null,
    issues: [{ row_number: rowNumber, severity: "rejected", reason_code, message, raw: rawLine }],
  });
  const warn = (reason_code: string, message: string) =>
    issues.push({ row_number: rowNumber, severity: "warning", reason_code, message, raw: rawLine });

  if (fields.length !== header.width) {
    return reject(
      "wrong_column_count",
      `Row has ${fields.length} fields but the header has ${header.width}; the row is broken or shifted.`,
    );
  }
  const get = (column: string) => (column in header.columns ? fields[header.columns[column]] : undefined);

  // A header row repeated mid-file (export concatenation) is not data.
  const repeated = Object.entries(header.columns).every(([canonical, index]) =>
    ALIASES[canonical].includes(normalizeName(fields[index] ?? "")),
  );
  if (repeated) return reject("repeated_header", "This row repeats the column names; it is not a record.");

  switch (header.kind) {
    case "contacts": {
      const externalId = text(get("external_id"), 64);
      if (!externalId) return reject("missing_external_id", "Customer id is missing.");

      const brandCode = get("brand_code");
      if (!isBlank(brandCode) && brandCode!.trim().toUpperCase() !== ctx.brandCode) {
        return reject(
          "wrong_brand",
          `Customer ${externalId} is marked as brand ${brandCode!.trim()}, not ${ctx.brandCode}. Not loaded into this brand.`,
        );
      }
      if (header.columns.brand_code !== undefined && isBlank(brandCode)) {
        warn("missing_brand_code", `Customer ${externalId} has no brand code; loaded as ${ctx.brandCode} because every other field is valid.`);
      }

      const status = normalizeStatus(get("status"));
      if (!status) {
        return reject(
          "invalid_status",
          `Status "${get("status") ?? ""}" is not a known customer status; the row is likely shifted or corrupt.`,
        );
      }

      const signup = parseLocalOrIsoTimestamp(get("signup_at"), ctx.timeZone);
      if (signup.invalid) return reject("invalid_signup_date", `Signup date "${get("signup_at")}" is not a valid date.`);
      if (signup.iso && new Date(signup.iso).getTime() > ctx.now.getTime()) {
        return reject("future_signup_date", `Signup date ${signup.iso} is in the future.`);
      }
      if (signup.local) {
        warn("signup_date_local_time", `Signup date "${get("signup_at")!.trim()}" has no timezone; read as day/month/year in ${ctx.timeZone} (${signup.iso}).`);
      }
      if (!signup.iso) warn("missing_signup_date", `Customer ${externalId} has no signup date.`);

      const email = normalizeEmail(get("email"));
      if (email.invalid) warn("invalid_email", `Email "${get("email")}" is not a valid address; customer kept but cannot be emailed.`);
      else if (!email.email) warn("missing_email", `Customer ${externalId} has no email address; customer kept but cannot be emailed.`);

      const country = normalizeCountry(get("country"));
      if (country.note) warn("country_normalised", `Customer ${externalId}: ${country.note}.`);

      const consent = normalizeConsent(get("consent_marketing"));
      if (consent.note) warn("consent_unrecognised", `Customer ${externalId}: ${consent.note}.`);

      const deleted = parseTimestamp(get("deleted_at"));
      if (deleted.invalid) warn("invalid_date", `Deleted date "${get("deleted_at")}" is not a valid date; ignored.`);
      const suppressed = parseTimestamp(get("suppressed_until"));
      if (suppressed.invalid) warn("invalid_date", `Suppressed-until date "${get("suppressed_until")}" is not a valid date; ignored.`);

      let notes = text(get("notes"), 100_000);
      if (notes && notes.length > 1000) {
        warn("notes_too_long", `Notes for ${externalId} are ${notes.length} characters (limit 1000); notes not stored.`);
        notes = null;
      }

      return {
        record: {
          row_number: rowNumber,
          external_id: externalId,
          full_name: text(get("full_name"), 200),
          email: email.email,
          phone: text(get("phone"), 40),
          country: country.code,
          city: text(get("city"), 120),
          status,
          consent_marketing: consent.value,
          signup_at: signup.iso,
          deleted_at: deleted.iso,
          suppressed_until: suppressed.iso,
          notes,
        },
        issues,
      };
    }

    case "campaigns": {
      const externalId = text(get("external_id"), 64);
      if (!externalId) return reject("missing_external_id", "Campaign id is missing.");
      const name = text(get("campaign_name"), 200);
      if (!name) return reject("missing_name", `Campaign ${externalId} has no name.`);
      const channel = normalizeChannel(get("channel"));
      if (!channel) return reject("invalid_channel", `Campaign ${externalId} has channel "${get("channel")}"; expected email or sms.`);

      const counts: Record<string, number | null> = {};
      for (const c of ["reported_sent", "reported_delivered", "reported_bounced", "reported_opens", "reported_clicks"]) {
        const parsed = parseCount(get(c));
        if (parsed.invalid) return reject("invalid_number", `Campaign ${externalId}: ${c} "${get(c)}" is not a whole number.`);
        counts[c] = parsed.n;
      }
      const spend = parseMoney(get("spend"));
      if (spend.invalid) return reject("invalid_number", `Campaign ${externalId}: spend "${get("spend")}" is not an amount.`);
      const sentAt = parseTimestamp(get("sent_at"));
      if (sentAt.invalid) return reject("invalid_date", `Campaign ${externalId}: sent date "${get("sent_at")}" is not a valid date.`);

      const country = normalizeCountry(get("target_country"));
      if (country.note) warn("country_normalised", `Campaign ${externalId}: target ${country.note}.`);

      return {
        record: {
          row_number: rowNumber,
          external_id: externalId,
          name,
          channel,
          target_country: country.code,
          ...counts,
          spend: spend.n,
          sent_at: sentAt.iso,
          send_local_time: text(get("send_local_time"), 40),
          parent_external_id: text(get("parent_campaign_id"), 64),
        },
        issues,
      };
    }

    case "events": {
      const eventId = text(get("event_id"), 128);
      if (!eventId) return reject("missing_event_id", "Event id is missing.");
      const contact = text(get("external_contact_id"), 64);
      const campaign = text(get("campaign_external_id"), 64);
      if (!contact || !campaign) return reject("missing_reference", `Event ${eventId} is missing its customer or campaign id.`);
      const type = normalizeEventType(get("event_type"));
      if (!type) return reject("invalid_event_type", `Event ${eventId} has unknown type "${get("event_type")}".`);
      const channel = normalizeChannel(get("channel"));
      if (!channel) return reject("invalid_channel", `Event ${eventId} has channel "${get("channel")}"; expected email or sms.`);
      const at = parseTimestamp(get("occurred_at"));
      if (at.invalid || !at.iso) return reject("invalid_date", `Event ${eventId} has an invalid time "${get("occurred_at")}".`);
      if (new Date(at.iso).getTime() > ctx.now.getTime()) return reject("future_date", `Event ${eventId} is dated in the future (${at.iso}).`);
      return {
        record: {
          row_number: rowNumber,
          event_id: eventId,
          contact_external_id: contact,
          campaign_external_id: campaign,
          type,
          channel,
          occurred_at: at.iso,
          raw: rawLine,
        },
        issues,
      };
    }

    case "send_log": {
      const batchKey = text(get("batch_key"), 64);
      if (!batchKey) return reject("missing_batch_key", "Send batch key is missing.");
      const campaign = text(get("campaign_external_id"), 64);
      if (!campaign) return reject("missing_reference", `Send ${batchKey} has no campaign id.`);
      const queued = parseTimestamp(get("queued_at"));
      if (queued.invalid) return reject("invalid_date", `Send ${batchKey} has an invalid queued time.`);
      const count = parseCount(get("recipient_count"));
      if (count.invalid) return reject("invalid_number", `Send ${batchKey} has an invalid recipient count.`);
      return {
        record: {
          row_number: rowNumber,
          batch_key: batchKey,
          campaign_external_id: campaign,
          queued_at: queued.iso,
          recipient_count: count.n,
          status: text(get("status"), 40),
          raw: rawLine,
        },
        issues,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk preparation
// ---------------------------------------------------------------------------

async function sha1Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash each record's content (so re-imports of identical rows are no-ops) and
 * collapse repeats of the same id inside one chunk — the database cannot upsert
 * the same key twice in one statement. Last row wins; conflicting repeats are
 * reported. Events and send logs are deduplicated by the database.
 */
export async function prepareRecords(kind: ImportKind, records: Record<string, unknown>[]) {
  const issues: Issue[] = [];
  if (kind !== "contacts" && kind !== "campaigns") return { records, issues };

  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const { row_number: _row, ...content } = record;
    record.row_hash = await sha1Hex(JSON.stringify(content));
    const id = record.external_id as string;
    const previous = byId.get(id);
    if (previous && previous.row_hash !== record.row_hash) {
      issues.push({
        row_number: record.row_number as number,
        severity: "warning",
        reason_code: "duplicate_external_id",
        message: `${kind === "contacts" ? "Customer" : "Campaign"} ${id} appears more than once in this file with different details; the later row was kept.`,
        raw: null,
      });
    }
    byId.set(id, record);
  }
  return { records: [...byId.values()], issues };
}

/**
 * Validate every complete line of a chunk. `firstRowNumber` is the 1-based data
 * row number of the first line (the header is row 0).
 */
export function validateLines(header: HeaderInfo, rawLines: string[], firstRowNumber: number, ctx: ValidationContext) {
  const records: Record<string, unknown>[] = [];
  const issues: Issue[] = [];
  // Postgres text cannot hold NUL characters: remove them and say so on rows that load.
  const lines = rawLines.map((line) => line.replaceAll(" ", ""));
  // One parse for the whole chunk (CPU budget); fall back to per-line parsing
  // if a quoted field spans lines and the two no longer line up.
  const parsed = parseDelimited(lines.join("\n"), header.delimiter);
  const aligned = parsed.length === lines.length;
  lines.forEach((line, i) => {
    const rowNumber = firstRowNumber + i;
    const fields = (aligned ? parsed[i] : parseDelimited(line, header.delimiter)[0]) ?? [];
    const result = validateRow(header, fields, rowNumber, line.length > 2000 ? `${line.slice(0, 2000)}…` : line, ctx);
    if (result.record) records.push(result.record);
    issues.push(...result.issues);
    if (result.record && line !== rawLines[i]) {
      issues.push({ row_number: rowNumber, severity: "warning", reason_code: "nul_character_removed",
        message: "This row contained NUL characters, which were removed.", raw: line });
    }
  });
  return { records, issues };
}

/** Quick whole-file check: does the brand column say this file belongs to another brand? */
export function dominantForeignBrand(header: HeaderInfo, lines: string[], brandCode: string): string | null {
  const index = header.columns.brand_code;
  if (index === undefined || lines.length === 0) return null;
  const counts = new Map<string, number>();
  for (const line of lines) {
    const value = (parseDelimited(line, header.delimiter)[0] ?? [])[index]?.trim().toUpperCase();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top && top[0] !== brandCode && top[1] > lines.length / 2 ? top[0] : null;
}
