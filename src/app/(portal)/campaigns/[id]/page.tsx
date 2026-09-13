/**
 * One campaign: its source-file and event figures side by side, its send
 * history, and for owners the send preview (audience rule, "N customers → M
 * addresses", last sent, the recipient list) with the confirm control.
 * Analysts get no send control; the database refuses them regardless.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, EmptyState, Notice, PageHeader, Pager, Table, Td } from "@/components/ui";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";
import { ConfirmSend } from "./confirm-send";

export const metadata: Metadata = { title: "Campaign" };

const RECIPIENTS_PAGE = 50;

export default async function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  const portal = await getPortal();
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) notFound();
  const sp = await searchParams;
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const tz = portal.brand.timezone;
  const isOwner = portal.role === "owner";

  const supabase = await createClient();
  const [campaignRes, overviewRes, performanceRes, sendsRes] = await Promise.all([
    supabase.from("campaigns").select("id, external_id, name, channel, target_country, spend, sent_at").eq("id", campaignId).maybeSingle(),
    supabase.rpc("campaigns_overview"),
    supabase.rpc("dashboard_campaign_performance"),
    supabase
      .from("sends")
      .select("id, status, approved_by_email, approved_at, addresses_count, customers_count, finished_at")
      .eq("campaign_id", campaignId)
      .order("approved_at", { ascending: false }),
  ]);
  for (const r of [campaignRes, overviewRes, performanceRes, sendsRes]) {
    if (r.error) throw new Error(`Campaign query failed: ${r.error.message}`);
  }
  // RLS hides other brands' campaigns, so they are indistinguishable from ones that never existed.
  const campaign = campaignRes.data;
  if (!campaign) notFound();

  const overview = ((overviewRes.data ?? []) as Overview[]).find((c) => c.campaign_id === campaignId);
  const perf = ((performanceRes.data ?? []) as Performance[]).find((c) => c.campaign_id === campaignId);
  const sends = (sendsRes.data ?? []) as SendRow[];

  let preview: Preview | null = null;
  let recipients: Recipient[] = [];
  if (isOwner && campaign.channel === "email") {
    const [p, r] = await Promise.all([
      supabase.rpc("preview_send", { p_campaign_id: campaignId }).maybeSingle(),
      supabase.rpc("preview_send_recipients", { p_campaign_id: campaignId, p_limit: RECIPIENTS_PAGE, p_offset: (page - 1) * RECIPIENTS_PAGE }),
    ]);
    if (p.error) throw new Error(`Send preview failed: ${p.error.message}`);
    if (r.error) throw new Error(`Recipient preview failed: ${r.error.message}`);
    preview = p.data as Preview | null;
    recipients = (r.data ?? []) as Recipient[];
  }

  const denominator = perf?.events_denominator;
  const figures: [string, number | null | undefined, number | null | undefined][] = [
    ["Delivered", perf?.reported_delivered, perf?.events_delivered],
    ["Opened", perf?.reported_opens, perf?.events_opened],
    ["Clicked", perf?.reported_clicks, perf?.events_clicked],
    ["Bounced", perf?.reported_bounced, perf?.events_bounced],
    ["Unsubscribed", null, perf?.events_unsubscribed],
    ["Complained", null, perf?.events_complained],
  ];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/campaigns" className="text-accent-ink hover:underline">
          ← Campaigns
        </Link>
      </p>
      <PageHeader
        title={campaign.name}
        description={
          <>
            {campaign.external_id} · {campaign.channel === "email" ? "Email" : "SMS"} ·{" "}
            {campaign.target_country ? `customers in ${campaign.target_country}` : "all countries"} · last sent{" "}
            {overview?.last_sent_at ? formatDateTime(overview.last_sent_at, tz) : "never"}
          </>
        }
      />

      <div className="space-y-4">
        <Card
          title="Performance"
          description={
            <>
              <strong>Reported</strong>: as stated in the campaigns source file. <strong>Counted</strong>: distinct customers per event type in loaded
              and provider events, duplicates counted once, as a share of the file&apos;s reported sent ({formatNumber(denominator)}).
            </>
          }
        >
          <Table head={["Measure", "Reported (source file)", `Counted from events (÷ ${formatNumber(denominator)} sent)`]}>
            <tr>
              <Td label="Measure">Sent</Td>
              <Td label="Reported (source file)" className="tabular-nums">
                {formatNumber(perf?.reported_sent)}
              </Td>
              <Td label="Counted from events" className="text-ink-3">
                Not in events
              </Td>
            </tr>
            {figures.map(([label, reported, counted]) => (
              <tr key={label}>
                <Td label="Measure">{label}</Td>
                <Td label="Reported (source file)" className="tabular-nums">
                  {reported === null ? <span className="text-ink-3">Not in file</span> : `${formatNumber(reported)} (${formatPercent(reported, perf?.reported_sent)})`}
                </Td>
                <Td label="Counted from events" className="tabular-nums">
                  {formatNumber(counted)} ({formatPercent(counted, denominator)})
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Send">
          {campaign.channel !== "email" ? (
            <Notice tone="accent">SMS campaigns cannot be sent from this portal; it sends email only.</Notice>
          ) : !isOwner ? (
            <Notice tone="accent">Only brand owners can send campaigns. You can follow every send and its recipients below.</Notice>
          ) : !preview ? (
            <EmptyState title="Send preview unavailable" />
          ) : (
            <div className="space-y-4">
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-ink-3">Audience</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                    {formatNumber(preview.customers)} customers → {formatNumber(preview.addresses)} addresses
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Last sent</dt>
                  <dd className="mt-0.5">{preview.last_sent_at ? `Last sent on ${formatDateTime(preview.last_sent_at, tz)}` : "Never sent"}</dd>
                </div>
                <div className="sm:col-span-3">
                  <dt className="text-ink-3">Audience rule</dt>
                  <dd className="mt-0.5">{preview.audience_rule}</dd>
                </div>
              </dl>

              {preview.in_flight_send_id ? (
                <Notice tone="warning">
                  A send for this campaign is already in progress.{" "}
                  <Link href={`/sends/${preview.in_flight_send_id}`} className="underline">
                    Follow it
                  </Link>
                  .
                </Notice>
              ) : preview.sendable ? (
                <ConfirmSend campaignId={campaignId} addresses={Number(preview.addresses)} customers={Number(preview.customers)} />
              ) : (
                <Notice tone="warning">{preview.not_sendable_reason}</Notice>
              )}

              {Number(preview.addresses) > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Recipients</h3>
                  <Table head={["Email", "Customers behind this address"]}>
                    {recipients.map((r) => (
                      <tr key={r.recipient_id}>
                        <Td label="Email" className="break-all">
                          {r.email}
                        </Td>
                        <Td label="Customers">
                          {r.contact_names.join(", ")}
                          {r.customers > 1 && <span className="text-ink-3"> ({r.customers}, one message)</span>}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                  <Pager page={page} pageSize={RECIPIENTS_PAGE} total={Number(preview.addresses)} href={(p) => `/campaigns/${campaignId}?page=${p}`} />
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Sends from this portal">
          {sends.length === 0 ? (
            <EmptyState title="No sends approved in this portal yet" />
          ) : (
            <Table head={["Approved", "Approved by", "Addresses", "Status"]}>
              {sends.map((s) => (
                <tr key={s.id}>
                  <Td label="Approved">
                    <Link href={`/sends/${s.id}`} className="text-accent-ink hover:underline">
                      {formatDateTime(s.approved_at, tz)}
                    </Link>
                  </Td>
                  <Td label="Approved by" className="break-all">
                    {s.approved_by_email}
                  </Td>
                  <Td label="Addresses" className="tabular-nums">
                    {formatNumber(s.addresses_count)} ({formatNumber(s.customers_count)} customers)
                  </Td>
                  <Td label="Status">
                    <Badge tone={s.status === "completed" ? "good" : "warning"}>{s.status === "completed" ? "Finished" : "Sending"}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

interface Overview {
  campaign_id: number;
  last_sent_at: string | null;
}
interface Performance {
  campaign_id: number;
  reported_sent: number | null;
  reported_delivered: number | null;
  reported_bounced: number | null;
  reported_opens: number | null;
  reported_clicks: number | null;
  events_delivered: number;
  events_opened: number;
  events_clicked: number;
  events_bounced: number;
  events_unsubscribed: number;
  events_complained: number;
  events_denominator: number | null;
}
interface Preview {
  audience_rule: string;
  customers: number;
  addresses: number;
  last_sent_at: string | null;
  in_flight_send_id: string | null;
  sendable: boolean;
  not_sendable_reason: string | null;
}
interface Recipient {
  email: string;
  recipient_id: string;
  customers: number;
  contact_names: string[];
}
interface SendRow {
  id: string;
  status: string;
  approved_by_email: string;
  approved_at: string;
  addresses_count: number;
  customers_count: number;
  finished_at: string | null;
}
