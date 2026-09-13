/**
 * Parser and validation rules, run against the real seed files.
 * No database needed: this proves which rows are rejected, warned or kept.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeBytes,
  dominantForeignBrand,
  normalizeCountry,
  parseHeader,
  parseLocalOrIsoTimestamp,
  parseMoney,
  parseTimestamp,
  prepareRecords,
  readChunk,
  splitLines,
  stripBom,
  validateLines,
  type Encoding,
  type HeaderInfo,
} from "../supabase/functions/_shared/ingest";

const seed = (name: string) => readFileSync(path.join(__dirname, "..", "data", "seed", name));
const now = new Date("2026-09-13T12:00:00Z");
const ZONES: Record<string, string> = { KILELE: "Africa/Nairobi", KAROO: "Africa/Johannesburg", MARRAKECH: "Africa/Casablanca" };

function loadWhole(name: string, brandCode: string) {
  const { text, encoding } = decodeBytes(seed(name));
  const lines = splitLines(stripBom(text));
  const head = parseHeader(lines[0]);
  if (!head.ok) throw new Error(head.message);
  const result = validateLines(head.header, lines.slice(1), 1, { brandCode, timeZone: ZONES[brandCode], now });
  return { ...result, header: head.header, encoding, dataRows: lines.length - 1 };
}

const count = (issues: { reason_code: string; severity: string }[], code: string, severity = "rejected") =>
  issues.filter((i) => i.reason_code === code && i.severity === severity).length;

describe("header detection", () => {
  it("recognises each brand's contact layout", () => {
    for (const [file, delimiter] of [
      ["kilele-contacts.csv", ","],
      ["karoo-contacts.csv", ","],
      ["marrakech-contacts.csv", ";"],
    ] as const) {
      const lines = splitLines(stripBom(decodeBytes(seed(file)).text));
      const head = parseHeader(lines[0]);
      expect(head.ok && head.header.kind).toBe("contacts");
      expect(head.ok && head.header.delimiter).toBe(delimiter);
    }
  });

  it("recognises campaigns, events and send logs", () => {
    const kind = (file: string) => {
      const head = parseHeader(splitLines(stripBom(decodeBytes(seed(file)).text))[0]);
      return head.ok ? head.header.kind : head.message;
    };
    expect(kind("kilele-campaigns.csv")).toBe("campaigns");
    expect(kind("marrakech-events.csv")).toBe("events");
    expect(kind("kilele-send-log.csv")).toBe("send_log");
  });

  it("refuses a file with missing required columns", () => {
    const head = parseHeader("external_id,full_name,phone");
    expect(head.ok).toBe(false);
  });

  it("refuses something that is not a CSV", () => {
    expect(parseHeader("%PDF-1.7 binary").ok).toBe(false);
  });
});

describe("field rules", () => {
  it("normalises countries and reports unknowns", () => {
    expect(normalizeCountry("KEN").code).toBe("KE");
    expect(normalizeCountry("254").code).toBe("KE");
    expect(normalizeCountry(" ke ").code).toBe("KE");
    expect(normalizeCountry("N/A")).toEqual({ code: null });
    expect(normalizeCountry("ZZ").code).toBeNull();
  });

  it("reads decimal-comma amounts exactly", () => {
    expect(parseMoney("221,09").n).toBe(221.09);
    expect(parseMoney("61.81").n).toBe(61.81);
    expect(parseMoney("12,5,0").invalid).toBe(true);
  });

  it("parses strict timestamps only", () => {
    expect(parseTimestamp("2026-03-07T10:42:18.187492Z").iso).toBe("2026-03-07T10:42:18.187Z");
    expect(parseTimestamp("next tuesday").invalid).toBe(true);
  });

  it("reads zone-less day/month/year signups as brand local time", () => {
    expect(parseLocalOrIsoTimestamp("22/02/2026 12:29", "Africa/Nairobi")).toEqual({
      iso: "2026-02-22T09:29:00.000Z",
      invalid: false,
      local: true,
    });
    expect(parseLocalOrIsoTimestamp("31/02/2026 12:00", "Africa/Nairobi").invalid).toBe(true);
    expect(parseLocalOrIsoTimestamp("2026-02-22T12:29:00Z", "Africa/Nairobi").local).toBe(false);
  });
});

describe("Karoo contacts (cp1252, shifted rows, foreign brand rows)", () => {
  const r = loadWhole("karoo-contacts.csv", "KAROO");

  it("decodes the Windows-1252 export", () => {
    expect(r.encoding).toBe("windows-1252");
    expect(r.records.some((c) => String(c.full_name).includes("–"))).toBe(true);
  });

  it("rejects rows belonging to Kilele instead of loading them", () => {
    expect(count(r.issues, "wrong_brand")).toBe(88);
    expect(r.records.some((c) => String(c.email ?? "").startsWith("leak.kil"))).toBe(false);
  });

  it("rejects broken and shifted rows", () => {
    expect(count(r.issues, "wrong_column_count")).toBe(46);
    // Shifted rows (city text in the status column) never become customers.
    expect(r.records.some((c) => c.city === null && c.country === null && c.status === "active" && !c.email)).toBe(false);
  });

  it("accounts for every row", () => {
    const rejected = r.issues.filter((i) => i.severity === "rejected").length;
    expect(r.records.length + rejected).toBe(r.dataRows);
  });
});

describe("Kilele contacts", () => {
  const r = loadWhole("kilele-contacts.csv", "KILELE");

  it("rejects Karoo-coded rows and future signups", () => {
    expect(count(r.issues, "wrong_brand")).toBe(312);
    expect(count(r.issues, "future_signup_date")).toBeGreaterThan(0);
  });

  it("keeps the 1,200 day/month/year signups, each with a warning", () => {
    expect(count(r.issues, "invalid_signup_date")).toBe(0);
    expect(count(r.issues, "signup_date_local_time", "warning")).toBe(1200);
  });

  it("keeps customers with invalid emails but stores no email", () => {
    expect(count(r.issues, "invalid_email", "warning")).toBeGreaterThan(0);
    const invalid = r.records.filter((c) => c.email === null).length;
    expect(invalid).toBeGreaterThan(0);
  });

  it("never stores a malformed email", () => {
    for (const c of r.records) {
      if (c.email !== null) expect(String(c.email)).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    }
  });

  it("collapses repeated ids within a chunk, last row wins", async () => {
    const prepared = await prepareRecords("contacts", r.records);
    const ids = new Set(prepared.records.map((c) => c.external_id));
    expect(ids.size).toBe(prepared.records.length);
  });
});

describe("Marrakech", () => {
  it("parses semicolon contacts and decimal-comma campaigns", () => {
    const contacts = loadWhole("marrakech-contacts.csv", "MARRAKECH");
    expect(contacts.records.length).toBeGreaterThan(900);
    const campaigns = loadWhole("marrakech-campaigns.csv", "MARRAKECH");
    expect(campaigns.records.find((c) => c.external_id === "MAR-0001")?.spend).toBe(221.09);
  });
});

describe("byte-range chunking", () => {
  // Mirrors the process-imports worker: header from the first range, row
  // numbers carried across ranges, encoding decided once.
  function loadChunked(name: string, brandCode: string, chunkBytes: number) {
    const bytes = seed(name);
    let cursor = 0;
    let encoding: Encoding | null = null;
    let header: HeaderInfo | null = null;
    let rows = 0;
    const records: Record<string, unknown>[] = [];
    const issues: { reason_code: string; severity: string; row_number: number | null }[] = [];
    while (cursor < bytes.length) {
      const slice = bytes.subarray(cursor, cursor + chunkBytes);
      const chunk = readChunk(slice, cursor + slice.length >= bytes.length, encoding);
      if (!chunk) throw new Error("line longer than chunk");
      encoding = chunk.encoding;
      const lines = chunk.lines;
      if (!header) {
        const head = parseHeader(lines.shift()!);
        if (!head.ok) throw new Error(head.message);
        header = head.header;
      }
      const result = validateLines(header, lines, rows + 1, { brandCode, timeZone: ZONES[brandCode], now });
      records.push(...result.records);
      issues.push(...result.issues);
      rows += lines.length;
      cursor += chunk.consumed;
    }
    return { records, issues, encoding };
  }

  it.each([
    ["karoo-contacts.csv", "KAROO"],
    ["kilele-contacts-delta-2026-09-01.csv", "KILELE"],
    ["marrakech-contacts.csv", "MARRAKECH"],
    ["marrakech-events.csv", "MARRAKECH"],
  ])("%s gives the same rows and issues as a whole-file read", (file, brand) => {
    const whole = loadWhole(file, brand);
    const chunked = loadChunked(file, brand, 64 * 1024);
    expect(chunked.encoding ?? "utf-8").toBe(whole.encoding);
    expect(chunked.records).toEqual(whole.records);
    expect(chunked.issues).toEqual(whole.issues);
  });

  it("decides cp1252 even when the first range is plain ASCII", () => {
    const ascii = new TextEncoder().encode("a,b\n1,2\n");
    const first = readChunk(ascii, false, null)!;
    expect(first.encoding).toBeNull();
    const later = readChunk(Uint8Array.from([0x96, 0x0a]), true, first.encoding)!;
    expect(later.encoding).toBe("windows-1252");
    expect(later.lines).toEqual(["–"]);
  });

  it("refuses a non-final range without a newline", () => {
    expect(readChunk(new TextEncoder().encode("no newline"), false, null)).toBeNull();
  });
});

describe("wrong-brand file", () => {
  it("is detected before anything is stored", () => {
    const lines = splitLines(stripBom(decodeBytes(seed("karoo-contacts.csv")).text));
    const head = parseHeader(lines[0]);
    expect(dominantForeignBrand((head as { header: HeaderInfo }).header, lines.slice(1, 500), "KILELE")).toBe("KAROO");
    expect(dominantForeignBrand((head as { header: HeaderInfo }).header, lines.slice(1, 500), "KAROO")).toBeNull();
  });
});
