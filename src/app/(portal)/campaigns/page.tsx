/** Campaigns list: channel, last sent, and whether (and why not) it can be sent here. */
import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Campaigns" };

interface CampaignOverview {
  campaign_id: number;
  external_id: string;
  name: string;
  channel: "email" | "sms";
  target_country: string | null;
  sent_at: string | null;
  last_sent_at: string | null;
  in_flight_send_id: string | null;
  sendable: boolean;
  not_sendable_reason: string | null;
}

export default async function CampaignsPage() {
  const portal = await getPortal();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("campaigns_overview");
  if (error) throw new Error(`Campaigns query failed: ${error.message}`);
  const campaigns = (data ?? []) as CampaignOverview[];
  const tz = portal.brand.timezone;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description={`Last sent is the latest of a send approved in this portal, the source file's send date and the historical send log. Times in ${tz}.`}
      />
      <Card>
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns loaded yet">
            Load a campaigns file on the{" "}
            <Link href="/imports" className="text-accent-ink underline">
              Imports
            </Link>{" "}
            screen.
          </EmptyState>
        ) : (
          <Table head={["Campaign", "Channel", "Audience", "Last sent", "Sending"]}>
            {campaigns.map((c) => (
              <tr key={c.campaign_id}>
                <Td label="Campaign">
                  <Link href={`/campaigns/${c.campaign_id}`} className="font-medium text-accent-ink hover:underline">
                    {c.name}
                  </Link>
                  <span className="block text-xs text-ink-3">{c.external_id}</span>
                </Td>
                <Td label="Channel">
                  <Badge>{c.channel === "email" ? "Email" : "SMS"}</Badge>
                </Td>
                <Td label="Audience">{c.target_country ? `Customers in ${c.target_country}` : "All countries"}</Td>
                <Td label="Last sent">{c.last_sent_at ? formatDateTime(c.last_sent_at, tz) : "Never sent"}</Td>
                <Td label="Sending">
                  {c.in_flight_send_id ? (
                    <Link href={`/sends/${c.in_flight_send_id}`}>
                      <Badge tone="warning">Send in progress</Badge>
                    </Link>
                  ) : c.sendable ? (
                    <Badge tone="good">Can be sent</Badge>
                  ) : (
                    <span className="text-xs text-ink-2">{c.not_sendable_reason}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
