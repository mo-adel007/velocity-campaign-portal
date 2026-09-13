"use client";

import { useActionState, useState } from "react";
import { buttonClass, Notice } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { approveSend, type ApproveState } from "../actions";

export function ConfirmSend({ campaignId, addresses, customers }: { campaignId: number; addresses: number; customers: number }) {
  const [state, action, pending] = useActionState(approveSend, {} as ApproveState);
  const [checked, setChecked] = useState(false);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="campaign_id" value={campaignId} />
      <input type="hidden" name="expected_addresses" value={addresses} />
      {state.error && <Notice tone="critical">{state.error}</Notice>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" />
        <span>
          I have reviewed the audience and approve sending this campaign to {formatNumber(addresses)} email addresses ({formatNumber(customers)} customers).
          This approval is permanent.
        </span>
      </label>
      <button type="submit" disabled={!checked || pending} className={buttonClass}>
        {pending ? "Approving…" : `Approve and send to ${formatNumber(addresses)} addresses`}
      </button>
    </form>
  );
}
