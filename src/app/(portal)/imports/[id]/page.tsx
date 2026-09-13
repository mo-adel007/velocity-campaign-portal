/** One import run: its counts and every rejected row or warning, with row number, reason and raw content. */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from "@/components/ui";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";
import { RunStatus, type ImportRun, RUN_COLUMNS } from "../run";

export const metadata: Metadata = { title: "Import" };

const PAGE_SIZE = 50;

export default async function ImportPage({ params, searchParams }: PageProps<"/imports/[id]">) {
  const portal = await getPortal();
  const runId = Number((await params).id);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();
  const sp = await searchParams;
  const severity = sp.severity === "warning" ? "warning" : "rejected";
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const tz = portal.brand.timezone;

  const supabase = await createClient();
  const [runRes, issuesRes] = await Promise.all([
    supabase.from("import_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle(),
    supabase
      .from("import_issues")
      .select("id, row_number, reason_code, message, raw", { count: "exact" })
      .eq("import_run_id", runId)
      .eq("severity", severity)
      .order("row_number", { ascending: true, nullsFirst: true })
      .order("id")
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  ]);
  if (runRes.error) throw new Error(`Import query failed: ${runRes.error.message}`);
  if (issuesRes.error && issuesRes.error.code !== "PGRST103") throw new Error(`Import issues query failed: ${issuesRes.error.message}`);
  const run = runRes.data as unknown as ImportRun | null;
  if (!run) notFound();
  const issues = (issuesRes.data ?? []) as Issue[];
  const href = (p: number, s = severity) => `/imports/${runId}?severity=${s}&page=${p}`;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/imports" className="text-accent-ink hover:underline">
          ← Imports
        </Link>
      </p>
      <PageHeader
        title={run.file_name}
        description={
          <>
            {run.kind ?? "Type not detected yet"} · queued {formatDateTime(run.created_at, tz)}
            {run.finished_at && ` · finished ${formatDateTime(run.finished_at, tz)}`}
          </>
        }
        actions={<RunStatus run={run} />}
      />
      <div className="space-y-4">
        {(run.status === "queued" || run.status === "processing") && <AutoRefresh />}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatTile label="Rows read" value={formatNumber(run.rows_processed)} />
          <StatTile label="New" value={formatNumber(run.rows_inserted)} />
          <StatTile label="Updated" value={formatNumber(run.rows_updated)} />
          <StatTile label="Unchanged" value={formatNumber(run.rows_unchanged)} />
          <StatTile label="Merged duplicates" value={formatNumber(run.rows_merged)} note="Repeated ids in the file; the last row wins." />
          <StatTile label="Rejected" value={formatNumber(run.rows_rejected)} note="Not loaded. Listed below with the reason." />
        </div>
        <p className="text-xs text-ink-3">
          New + updated + unchanged + merged + rejected = {formatNumber(run.rows_inserted + run.rows_updated + run.rows_unchanged + run.rows_merged + run.rows_rejected)} of{" "}
          {formatNumber(run.rows_processed)} rows read. Warnings ({formatNumber(run.rows_warned)}) were loaded, with the noted change.
        </p>

        <Card title="Rows not loaded, and warnings">
          <nav aria-label="Issue type" className="mb-4 flex gap-2 text-sm">
            {(["rejected", "warning"] as const).map((s) => (
              <Link
                key={s}
                href={href(1, s)}
                aria-current={s === severity ? "page" : undefined}
                className={`rounded-md border px-3 py-1 ${s === severity ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:bg-surface-0"}`}
              >
                {s === "rejected" ? `Rejected (${formatNumber(run.rows_rejected)})` : `Warnings (${formatNumber(run.rows_warned)})`}
              </Link>
            ))}
          </nav>
          {issues.length === 0 ? (
            <EmptyState title={severity === "rejected" ? "No rejected rows" : "No warnings"} />
          ) : (
            <>
              <Table head={["Row", "Reason", "Raw content"]}>
                {issues.map((i) => (
                  <tr key={i.id}>
                    <Td label="Row" className="tabular-nums">
                      {i.row_number ?? "File"}
                    </Td>
                    <Td label="Reason">
                      <span className="font-medium">{i.message}</span>
                      <span className="block text-xs text-ink-3">{i.reason_code}</span>
                    </Td>
                    <Td label="Raw content">
                      {i.raw ? <code className="font-mono text-xs break-all whitespace-pre-wrap">{i.raw}</code> : "—"}
                    </Td>
                  </tr>
                ))}
              </Table>
              <Pager page={page} pageSize={PAGE_SIZE} total={issuesRes.count ?? 0} href={(p) => href(p)} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

interface Issue {
  id: number;
  row_number: number | null;
  reason_code: string;
  message: string;
  raw: string | null;
}
