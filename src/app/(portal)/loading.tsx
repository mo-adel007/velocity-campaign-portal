export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <p className="text-sm text-ink-2">Loading…</p>
      <div className="h-8 w-48 animate-pulse rounded-md bg-line" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-28 animate-pulse rounded-xl bg-line" />
        <div className="h-28 animate-pulse rounded-xl bg-line" />
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-line" />
    </div>
  );
}
