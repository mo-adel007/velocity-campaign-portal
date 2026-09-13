/** Display helpers. Dates are always shown in the brand's own timezone. */

const numberFormat = new Intl.NumberFormat("en-GB");

export const formatNumber = (n: number | string | null | undefined) => (n == null ? "—" : numberFormat.format(Number(n)));

export function formatPercent(part: number | string | null | undefined, whole: number | string | null | undefined) {
  if (part == null || whole == null || Number(whole) === 0) return "—";
  return `${((Number(part) / Number(whole)) * 100).toFixed(1)}%`;
}

export function formatDateTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDate(value: string | null | undefined, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium" }).format(new Date(value));
}

/** A calendar day ("2026-09-13") without shifting it through any timezone. */
export function formatDay(day: string, style: "short" | "long" = "short") {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(style === "long" ? { weekday: "short", year: "numeric" } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const REASON_LABELS: Record<string, string> = {
  contactable: "Contactable by email",
  deleted: "Deleted in source",
  invalid_email: "Missing or invalid email",
  complained: "Complained",
  unsubscribed: "Unsubscribed",
  bounced: "Email bounced",
  no_consent: "No marketing consent",
  pending: "Status pending",
  suppressed: "Temporarily suppressed",
};

export const reasonLabel = (reason: string | null) => (reason ? (REASON_LABELS[reason] ?? reason) : REASON_LABELS.contactable);

/** Database errors carry readable messages for the portal's own refusals; others get a generic line. */
export function actionError(error: { code?: string; message: string }) {
  if (error.code?.startsWith("VC") || error.code === "42501" || error.code === "22023") return error.message;
  return "Something went wrong. Nothing was changed. Please try again.";
}
