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
  parseMoney,
  parseTimestamp,
  prepareRecords,
  splitLines,
  stripBom,
  validateLines,
  type HeaderInfo,
} from "../supabase/functions/_shared/ingest";

const seed = (name: string) => readFileSync(path.join(__dirname, "..", "data", "seed", name));
const now = new Date("2026-09-13T12:00:00Z");

function loadWhole(name: string, brandCode: string) {
  const { text, encoding } = decodeBytes(seed(name));
  const lines = splitLines(stripBom(text));
  const head = parseHeader(lines[0]);
  if (!head.ok) throw new Error(head.message);
  const result = validateLines(head.header, lines.slice(1), 1, { brandCode, now });
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

describe("wrong-brand file", () => {
  it("is detected before anything is stored", () => {
    const lines = splitLines(stripBom(decodeBytes(seed("karoo-contacts.csv")).text));
    const head = parseHeader(lines[0]);
    expect(dominantForeignBrand((head as { header: HeaderInfo }).header, lines.slice(1, 500), "KILELE")).toBe("KAROO");
    expect(dominantForeignBrand((head as { header: HeaderInfo }).header, lines.slice(1, 500), "KAROO")).toBeNull();
  });
});
