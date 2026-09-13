/**
 * Thirty bars, one series. Today's bar is hatched and labelled "partial".
 * Hovering a bar shows its value; the same numbers are available as a table
 * for screen readers, keyboards and exact reading.
 */
import { formatNumber } from "@/lib/format";

interface Day {
  day: string;
  label: string;
  signups: number;
  partial: boolean;
}

export function SignupsChart({ days }: { days: Day[] }) {
  const peak = Math.max(0, ...days.map((d) => d.signups));
  const max = Math.max(1, peak);
  const total = days.reduce((s, d) => s + d.signups, 0);
  if (days.length === 0) return <p className="text-sm text-ink-2">No days to show.</p>;

  return (
    <div>
      <p className="mb-3 text-sm text-ink-2">
        {formatNumber(total)} signups in 30 days · peak {formatNumber(peak)} a day
      </p>
      <div className="flex h-40 items-end gap-[2px] border-b border-line" aria-hidden>
        {days.map((d, i) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div
              className={`w-full rounded-t-[2px] bg-series-1 ${d.partial ? "bar-partial" : ""}`}
              style={{ height: `${d.signups === 0 ? 0 : Math.max(2, (d.signups / max) * 100)}%` }}
            />
            <div className={`pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border border-line bg-surface-1 px-2 py-1 text-xs whitespace-nowrap shadow-sm group-hover:block ${i < 10 ? "left-0" : i >= days.length - 10 ? "right-0" : "left-1/2 -translate-x-1/2"}`}>
              <span className="font-medium tabular-nums">{formatNumber(d.signups)}</span> · {d.label}
              {d.partial && " (partial)"}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-3">
        <span>{days[0].label}</span>
        <span>Today (partial, hatched)</span>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-accent-ink">Show as table</summary>
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">Signups per day</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 text-right font-medium">Signups</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-b border-line">
                <td className="py-1">
                  {d.label}
                  {d.partial && <span className="text-ink-3"> · today, partial</span>}
                </td>
                <td className="py-1 text-right tabular-nums">{formatNumber(d.signups)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
