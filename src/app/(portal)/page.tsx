/**
 * Dashboard. Every figure comes from the dashboard_* RPCs, which run as the
 * signed-in user under forced RLS, so they only ever count this brand.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, StatTile, Table, Td } from "@/components/ui";
import { formatDate, formatDay, formatNumber, formatPercent, reasonLabel } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";
import { SignupsChart } from "./signups-chart";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const portal = await getPortal();
  const supabase = await createClient();
  const [totals, breakdown, signups, performance] = await Promise.all([
    supabase.rpc("dashboard_totals").maybeSingle(),
    supabase.rpc("dashboard_contactable_breakdown"),
    supabase.rpc("dashboard_signups_per_day"),
    supabase.rpc("dashboard_campaign_performance"),
  ]);
  for (const r of [totals, breakdown, signups, performance]) {
    if (r.error) throw new Error(`Dashboard query failed: ${r.error.message}`);
  }

  const t = totals.data as { total_customers: number; contactable_by_email: number; as_of: string } | null;
  const reasons = (breakdown.data ?? []) as { reason: string; customers: number }[];
  const days = (signups.data ?? []) as { day: string; signups: number; is_partial: boolean; timezone: string }[];
  const campaigns = (performance.data ?? []) as Performance[];
  const total = Number(t?.total_customers ?? 0);
  const breakdownSum = reasons.reduce((s, r) => s + Number(r.customers), 0);
  const exclusions = reasons.filter((r) => r.reason !== "contactable");
  const tz = portal.brand.timezone;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          <>
            {portal.brand.name} · figures as of {t ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeStyle: "short", dateStyle: "medium" }).format(new Date(t.as_of)) : "—"} ({tz})
          </>
        }
      />

      {total === 0 ? (
        <EmptyState title="No customers loaded yet">
          Load a contacts file on the <Link href="/imports" className="text-accent-ink underline">Imports</Link> screen to see figures here.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatTile
              label="Total customers"
              value={formatNumber(total)}
              note="Distinct customers loaded for this brand, one per customer id, including deleted and uncontactable ones."
            />
            <StatTile
              label="Contactable by email"
              value={formatNumber(t?.contactable_by_email)}
              note={`${formatPercent(t?.contactable_by_email, total)} of total. Valid email, marketing consent, and not deleted, unsubscribed, complained, bounced, pending or suppressed.`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card
              className="lg:col-span-2"
              title="Why customers cannot be emailed"
              description="Each customer is counted once, under the first reason that applies, in this order."
            >
              <ul className="divide-y divide-line text-sm">
                {reasons.map((r) => (
                  <li key={r.reason} className="flex justify-between gap-4 py-2">
                    <span className={r.reason === "contactable" ? "font-medium" : "text-ink-2"}>{reasonLabel(r.reason === "contactable" ? null : r.reason)}</span>
                    <span className="tabular-nums">
                      {formatNumber(r.customers)} <span className="text-ink-3">({formatPercent(r.customers, total)})</span>
                    </span>
                  </li>
                ))}
                <li className="flex justify-between gap-4 pt-2 font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">{formatNumber(breakdownSum)}</span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-ink-3">
                Contactable {formatNumber(t?.contactable_by_email)} + excluded {formatNumber(exclusions.reduce((s, r) => s + Number(r.customers), 0))} ={" "}
                {formatNumber(breakdownSum)}
                {breakdownSum === total ? " = total customers." : ` (total customers is ${formatNumber(total)}).`}
              </p>
            </Card>

            <Card
              className="lg:col-span-3"
              title="Signups per day"
              description={`Today and the 29 days before it, by signup date in ${tz}. Customers without a signup date are not shown here.`}
            >
              <SignupsChart days={days.map((d) => ({ day: d.day, label: formatDay(d.day, "long"), signups: Number(d.signups), partial: d.is_partial }))} />
            </Card>
          </div>

          <Card
            title="Campaign performance"
            description={
              <>
                <strong>Reported</strong> figures are copied from the campaigns source file. <strong>Counted</strong> figures are distinct customers per
                event type in the loaded and provider events, each event counted once; their rates are divided by the file&apos;s reported sent count.
              </>
            }
          >
            {campaigns.length === 0 ? (
              <EmptyState title="No campaigns loaded yet" />
            ) : (
              <Table head={["Campaign", "Sent", "Reported: sent / delivered / opens / clicks", "Counted: opened / clicked / bounced / unsubscribed"]}>
                {campaigns.map((c) => (
                  <tr key={c.campaign_id}>
                    <Td label="Campaign">
                      <Link href={`/campaigns/${c.campaign_id}`} className="font-medium text-accent-ink hover:underline">
                        {c.name}
                      </Link>
                      <span className="block text-xs text-ink-3">
                        {c.external_id} · {c.channel.toUpperCase()}
                      </span>
                    </Td>
                    <Td label="Sent">{formatDate(c.sent_at, tz)}</Td>
                    <Td label="Reported (file)" className="tabular-nums">
                      {formatNumber(c.reported_sent)} / {formatNumber(c.reported_delivered)} / {formatNumber(c.reported_opens)} / {formatNumber(c.reported_clicks)}
                    </Td>
                    <Td label={`Counted (÷ ${formatNumber(c.events_denominator)} sent)`} className="tabular-nums">
                      {formatNumber(c.events_opened)} <span className="text-ink-3">({formatPercent(c.events_opened, c.events_denominator)})</span> /{" "}
                      {formatNumber(c.events_clicked)} <span className="text-ink-3">({formatPercent(c.events_clicked, c.events_denominator)})</span> /{" "}
                      {formatNumber(c.events_bounced)} / {formatNumber(c.events_unsubscribed)}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

interface Performance {
  campaign_id: number;
  external_id: string;
  name: string;
  channel: string;
  sent_at: string | null;
  reported_sent: number | null;
  reported_delivered: number | null;
  reported_opens: number | null;
  reported_clicks: number | null;
  events_opened: number;
  events_clicked: number;
  events_bounced: number;
  events_unsubscribed: number;
  events_denominator: number | null;
}
