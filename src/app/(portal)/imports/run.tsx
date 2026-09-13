/** Shared shape and status badge for import runs (list and detail). */
import { Badge } from "@/components/ui";
import { formatPercent } from "@/lib/format";

export const RUN_COLUMNS =
  "id, kind, file_name, status, status_message, rows_processed, rows_inserted, rows_updated, rows_unchanged, rows_rejected, rows_warned, rows_merged, byte_cursor, file_size, created_at, started_at, finished_at";

export interface ImportRun {
  id: number;
  kind: string | null;
  file_name: string;
  status: "queued" | "processing" | "completed" | "refused" | "failed";
  status_message: string | null;
  rows_processed: number;
  rows_inserted: number;
  rows_updated: number;
  rows_unchanged: number;
  rows_rejected: number;
  rows_warned: number;
  rows_merged: number;
  byte_cursor: number;
  file_size: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const TONE = { queued: "neutral", processing: "accent", completed: "good", refused: "critical", failed: "critical" } as const;
const LABEL = { queued: "Queued", processing: "Loading", completed: "Loaded", refused: "Refused", failed: "Failed" };

export function RunStatus({ run }: { run: ImportRun }) {
  return (
    <span className="inline-flex flex-col items-end gap-1 sm:items-start">
      <Badge tone={TONE[run.status]}>
        {LABEL[run.status]}
        {run.status === "processing" && run.file_size ? ` · ${formatPercent(run.byte_cursor, run.file_size)}` : ""}
      </Badge>
      {run.status_message && (run.status === "refused" || run.status === "failed") && <span className="text-xs text-ink-2">{run.status_message}</span>}
    </span>
  );
}
