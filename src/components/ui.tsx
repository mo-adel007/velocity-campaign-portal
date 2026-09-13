/** Small presentational building blocks shared by every portal screen. */
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, description, children, className = "" }: { title?: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-surface-1 p-4 sm:p-5 ${className}`}>
      {title && <h2 className="text-base font-semibold">{title}</h2>}
      {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      <div className={title || description ? "mt-4" : ""}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-1 p-4 sm:p-5">
      <p className="text-sm text-ink-2">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {note && <p className="mt-2 text-xs text-ink-3">{note}</p>}
    </div>
  );
}

const TONES = {
  neutral: "bg-surface-0 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  good: "bg-good-soft text-good border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  critical: "bg-critical-soft text-critical border-transparent",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "good" | "warning" | "critical" | "accent"; children: ReactNode }) {
  const icon = { good: "✓", warning: "!", critical: "✕", accent: "i" }[tone];
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={`flex gap-2 rounded-lg px-3 py-2 text-sm ${TONES[tone]}`}>
      <span aria-hidden className="font-bold">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="rtable w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-3">
          {head.map((h) => (
            <th key={h} className="px-2 py-2 font-medium first:pl-0 last:pr-0">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Td({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <td data-label={label} className={`border-b border-line px-2 py-2 align-top first:pl-0 last:pr-0 ${className}`}>
      {children}
    </td>
  );
}

/** Previous/next paging through URL search params. */
export function Pager({ page, pageSize, total, href }: { page: number; pageSize: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const link = "rounded-md border border-line px-3 py-1.5 hover:bg-surface-0";
  const off = "rounded-md border border-line px-3 py-1.5 opacity-40";
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-2">
      <span>
        {from.toLocaleString("en-GB")}–{to.toLocaleString("en-GB")} of {total.toLocaleString("en-GB")}
      </span>
      <span className="flex gap-2">
        {page > 1 ? <Link className={link} href={href(page - 1)}>Previous</Link> : <span className={off}>Previous</span>}
        {page < pages ? <Link className={link} href={href(page + 1)}>Next</Link> : <span className={off}>Next</span>}
      </span>
    </nav>
  );
}

export const buttonClass =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-lg border border-line bg-surface-1 px-4 py-2 text-sm font-medium hover:bg-surface-0 disabled:opacity-50";
export const inputClass =
  "w-full rounded-lg border border-line bg-surface-1 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft";
