/**
 * Import history for every member; the upload form for owners only. Counts
 * per run add up: new + updated + unchanged + merged duplicates + rejected
 * = rows read.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, EmptyState, Notice, PageHeader, Pager, Table, Td } from "@/components/ui";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";
import { RunStatus, type ImportRun, RUN_COLUMNS } from "./run";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Imports" };

const PAGE_SIZE = 25;

export default async function ImportsPage({ searchParams }: PageProps<"/imports">) {
  const portal = await getPortal();
  const page = Math.max(1, Math.floor(Number((await searchParams).page)) || 1);
  const tz = portal.brand.timezone;

  const supabase = await createClient();
  const [runsRes, activeRes] = await Promise.all([
    supabase
      .from("import_runs")
      .select(RUN_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    supabase.from("import_runs").select("id", { count: "exact", head: true }).in("status", ["queued", "processing"]),
  ]);
  if (runsRes.error && runsRes.error.code !== "PGRST103") throw new Error(`Imports query failed: ${runsRes.error.message}`);
  if (activeRes.error) throw new Error(`Imports query failed: ${activeRes.error.message}`);
  const runs = (runsRes.data ?? []) as unknown as ImportRun[];

  return (
    <>
      <PageHeader title="Imports" description={`Every file loaded for ${portal.brand.name}, what it changed, and every row that was not loaded. Times in ${tz}.`} />
      <div className="space-y-4">
        <Card title="Load a file">
          {portal.role === "owner" ? (
            <UploadForm brandId={portal.brand.id} />
          ) : (
            <Notice tone="accent">Only brand owners can load files. You can see every import and its rejected rows below.</Notice>
          )}
        </Card>

        {(activeRes.count ?? 0) > 0 && <AutoRefresh />}

        <Card title="History">
          {runs.length === 0 ? (
            <EmptyState title="No files loaded yet" />
          ) : (
            <>
              <Table head={["File", "Status", "Rows read", "New / updated / unchanged / merged", "Rejected / warnings"]}>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td label="File">
                      <Link href={`/imports/${r.id}`} className="font-medium break-all text-accent-ink hover:underline">
                        {r.file_name}
                      </Link>
                      <span className="block text-xs text-ink-3">
                        {r.kind ?? "type not detected yet"} · {formatDateTime(r.created_at, tz)}
                      </span>
                    </Td>
                    <Td label="Status">
                      <RunStatus run={r} />
                    </Td>
                    <Td label="Rows read" className="tabular-nums">
                      {formatNumber(r.rows_processed)}
                    </Td>
                    <Td label="New / updated / unchanged / merged" className="tabular-nums">
                      {formatNumber(r.rows_inserted)} / {formatNumber(r.rows_updated)} / {formatNumber(r.rows_unchanged)} / {formatNumber(r.rows_merged)}
                    </Td>
                    <Td label="Rejected / warnings" className="tabular-nums">
                      <span className={r.rows_rejected > 0 ? "font-medium text-critical" : ""}>{formatNumber(r.rows_rejected)}</span> /{" "}
                      {formatNumber(r.rows_warned)}
                    </Td>
                  </tr>
                ))}
              </Table>
              <Pager page={page} pageSize={PAGE_SIZE} total={runsRes.count ?? 0} href={(p) => `/imports?page=${p}`} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
