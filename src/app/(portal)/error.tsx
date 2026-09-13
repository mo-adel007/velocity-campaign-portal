"use client";

import { Notice, secondaryButtonClass } from "@/components/ui";

export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">This screen could not load</h1>
      <Notice tone="critical">
        Something went wrong while loading this data. Nothing was changed.
        {error.digest && <span className="block text-xs opacity-80">Reference: {error.digest}</span>}
      </Notice>
      <button type="button" onClick={retry} className={secondaryButtonClass}>
        Try again
      </button>
    </div>
  );
}
