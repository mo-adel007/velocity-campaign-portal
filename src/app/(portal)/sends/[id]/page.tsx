/**
 * One approved send: the permanent approval (who, when, rule, counts), live
 * per-recipient progress and the recipients themselves, filterable by status
 * so suppressed and failed addresses show their reason.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from "@/components/ui";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Send" };

const PAGE_SIZE = 50;
const STATUSES = ["pending", "sent", "suppressed", "failed"] as const;
const STATUS_LABEL = { pending: "Waiting", sent: "Sent", suppressed: "Suppressed", failed: "Failed" };
const STATUS_TONE = { pending: "neutral", sent: "good", suppressed: "warning", failed: "critical" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SendPage({ params, searchParams }: PageProps<"/sends/[id]">) {
  const portal = await getPortal();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const filter = STATUSES.find((s) => s === sp.status);
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const tz = portal.brand.timezone;

  const supabase = await createClient();
  const { data: send, error } = await supabase
    .from("sends")
    .select("id, campaign_id, status, approved_by_email, approved_at, audience_rule, customers_count, addresses_count, chunk_size, finished_at, campaigns(name, external_id)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Send query failed: ${error.message}`);
  if (!send) notFound();

  const countOf = (status: string) =>
    supabase.from("send_recipients").select("id", { count: "exact", head: true }).eq("send_id", id).eq("status", status);
  let recipientsQuery = supabase
    .from("send_recipients")
    .select("id, email, recipient_id, status, reason, updated_at", { count: "exact" })
    .eq("send_id", id);
  if (filter) recipientsQuery = recipientsQuery.eq("status", filter);
  const [counts, chunks, recipients] = await Promise.all([
    Promise.all(STATUSES.map(countOf)),
    supabase.from("send_chunks").select("status").eq("send_id", id),
    recipientsQuery.order("chunk_no").order("recipient_id").range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  ]);
  for (const r of [...counts, chunks]) if (r.error) throw new Error(`Send progress query failed: ${r.error.message}`);
  if (recipients.error && recipients.error.code !== "PGRST103") throw new Error(`Recipients query failed: ${recipients.error.message}`);

  const byStatus = Object.fromEntries(STATUSES.map((s, i) => [s, counts[i].count ?? 0])) as Record<(typeof STATUSES)[number], number>;
  const chunkRows = (chunks.data ?? []) as { status: string }[];
  const chunksDone = chunkRows.filter((c) => c.status === "sent" || c.status === "failed").length;
  const campaign = send.campaigns as unknown as { name: string; external_id: string } | null;
  const rows = (recipients.data ?? []) as Recipient[];
  const href = (p: number, status = filter) => `/sends/${id}?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) })}`;
  const running = send.status === "dispatching";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/campaigns/${send.campaign_id}`} className="text-accent-ink hover:underline">
          ← {campaign?.name ?? "Campaign"}
        </Link>
      </p>
      <PageHeader
        title={`Send of ${campaign?.name ?? "campaign"}`}
        description={<Badge tone={running ? "warning" : "good"}>{running ? "Sending" : `Finished ${formatDateTime(send.finished_at, tz)}`}</Badge>}
      />

      <div className="space-y-4">
        <Card title="Approval" description="Recorded when the owner confirmed. It cannot be changed or deleted.">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-3">Approved by</dt>
              <dd className="break-all">{send.approved_by_email}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Approved at ({tz})</dt>
              <dd>{formatDateTime(send.approved_at, tz)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Approved audience</dt>
              <dd className="font-semibold tabular-nums">
                {formatNumber(send.customers_count)} customers → {formatNumber(send.addresses_count)} addresses
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Batches</dt>
              <dd className="tabular-nums">
                {formatNumber(chunksDone)} of {formatNumber(chunkRows.length)} done · up to {formatNumber(send.chunk_size)} addresses each
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-3">Audience rule</dt>
              <dd>{send.audience_rule}</dd>
            </div>
          </dl>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STATUSES.map((s) => (
            <StatTile key={s} label={STATUS_LABEL[s]} value={formatNumber(byStatus[s])} />
          ))}
        </div>
        <p className="text-xs text-ink-3">
          Waiting {formatNumber(byStatus.pending)} + sent {formatNumber(byStatus.sent)} + suppressed {formatNumber(byStatus.suppressed)} + failed{" "}
          {formatNumber(byStatus.failed)} = {formatNumber(STATUSES.reduce((n, s) => n + byStatus[s], 0))} of {formatNumber(send.addresses_count)} approved
          addresses. Suppressed addresses became ineligible after approval and were not messaged.
        </p>
        {running && <AutoRefresh />}

        <Card title="Recipients">
          <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2 text-sm">
            {[undefined, ...STATUSES].map((s) => (
              <Link
                key={s ?? "all"}
                href={href(1, s)}
                aria-current={s === filter ? "page" : undefined}
                className={`rounded-md border px-3 py-1 ${s === filter ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:bg-surface-0"}`}
              >
                {s ? `${STATUS_LABEL[s]} (${formatNumber(byStatus[s])})` : "All"}
              </Link>
            ))}
          </nav>
          {rows.length === 0 ? (
            <EmptyState title={filter ? `No ${STATUS_LABEL[filter].toLowerCase()} recipients` : "No recipients on this page"} />
          ) : (
            <>
              <Table head={["Email", "Status", "Reason", "Updated"]}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td label="Email" className="break-all">
                      {r.email}
                      <span className="block text-xs text-ink-3">{r.recipient_id}</span>
                    </Td>
                    <Td label="Status">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </Td>
                    <Td label="Reason">{r.reason ?? "—"}</Td>
                    <Td label="Updated">{formatDateTime(r.updated_at, tz)}</Td>
                  </tr>
                ))}
              </Table>
              <Pager page={page} pageSize={PAGE_SIZE} total={recipients.count ?? 0} href={(p) => href(p)} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

interface Recipient {
  id: number;
  email: string;
  recipient_id: string;
  status: (typeof STATUSES)[number];
  reason: string | null;
  updated_at: string;
}
