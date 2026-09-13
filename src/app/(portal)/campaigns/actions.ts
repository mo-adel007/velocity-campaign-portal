"use server";

import { redirect } from "next/navigation";
import { actionError } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export interface ApproveState {
  error?: string;
}

/**
 * Confirms a send. The database decides everything that matters: owner only,
 * email only, one in flight, and the audience still has the address count the
 * owner reviewed (otherwise nothing is created and they must review again).
 */
export async function approveSend(_: ApproveState, form: FormData): Promise<ApproveState> {
  const campaignId = Number(form.get("campaign_id"));
  const expected = Number(form.get("expected_addresses"));
  if (!Number.isSafeInteger(campaignId) || !Number.isSafeInteger(expected)) return { error: "This send request is incomplete. Reload the page." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_send", { p_campaign_id: campaignId, p_expected_addresses: expected });
  if (error) return { error: actionError(error) };
  redirect(`/sends/${(data as { id: string }).id}`);
}
