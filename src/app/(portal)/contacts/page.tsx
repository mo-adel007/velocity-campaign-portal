/**
 * Contacts: search by name, email or customer id, 50 per page. Each row shows
 * whether the customer can be emailed and, if not, why (the same
 * `contact_block_reason` the dashboard and the send audience use).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, inputClass, PageHeader, Pager, secondaryButtonClass, Table, Td } from "@/components/ui";
import { formatDate, formatNumber, reasonLabel } from "@/lib/format";
import { getPortal } from "@/lib/portal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Contacts" };

const PAGE_SIZE = 50;

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const portal = await getPortal();
  const params = await searchParams;
  // Characters with meaning in PostgREST filters or LIKE patterns are dropped, not interpreted.
  const q = (typeof params.q === "string" ? params.q : "").replace(/[%*,()"\\]/g, " ").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);

  const supabase = await createClient();
  let query = supabase
    .from("contacts")
    .select("id, external_id, full_name, email, country, city, status, signup_at, contact_block_reason", { count: "exact" })
    .eq("brand_id", portal.brand.id);
  if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,external_id.ilike.%${q}%`);
  const { data, count, error } = await query
    .order("full_name", { ascending: true, nullsFirst: false })
    .order("id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  // PGRST103: a page past the end (e.g. an old link after a narrower search) is just empty.
  if (error && error.code !== "PGRST103") throw new Error(`Contacts query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as Contact[];
  const href = (p: number) => `/contacts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader title="Contacts" description={`Every loaded customer of ${portal.brand.name}. Search by name, email or customer id.`} />
      <Card>
        <form role="search" action="/contacts" className="mb-4 flex gap-2">
          <label className="sr-only" htmlFor="q">
            Search contacts
          </label>
          <input id="q" name="q" type="search" defaultValue={q} placeholder="Name, email or customer id" className={inputClass} />
          <button type="submit" className={secondaryButtonClass}>
            Search
          </button>
        </form>

        {rows.length === 0 ? (
          <EmptyState title={q ? `No contacts match “${q}”` : "No contacts loaded yet"}>
            {q ? (
              <Link href="/contacts" className="text-accent-ink underline">
                Clear the search
              </Link>
            ) : (
              <>
                Load a contacts file on the{" "}
                <Link href="/imports" className="text-accent-ink underline">
                  Imports
                </Link>{" "}
                screen.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <Table head={["Customer", "Email", "Location", "Signed up", "Email status"]}>
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td label="Customer">
                    <span className="font-medium">{c.full_name ?? "—"}</span>
                    <span className="block text-xs text-ink-3">{c.external_id}</span>
                  </Td>
                  <Td label="Email" className="break-all">
                    {c.email ?? <span className="text-ink-3">none</span>}
                  </Td>
                  <Td label="Location">{[c.city, c.country].filter(Boolean).join(", ") || "—"}</Td>
                  <Td label="Signed up">{formatDate(c.signup_at, portal.brand.timezone)}</Td>
                  <Td label="Email status">
                    <Badge tone={c.contact_block_reason ? "neutral" : "good"}>{reasonLabel(c.contact_block_reason)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={PAGE_SIZE} total={count ?? 0} href={href} />
          </>
        )}
        {q && rows.length > 0 && <p className="mt-2 text-xs text-ink-3">{formatNumber(count)} matching contacts.</p>}
      </Card>
    </>
  );
}

interface Contact {
  id: number;
  external_id: string;
  full_name: string | null;
  email: string | null;
  country: string | null;
  city: string | null;
  status: string;
  signup_at: string | null;
  contact_block_reason: string | null;
}
