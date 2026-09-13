/**
 * Brand isolation, tested against the live project (AC1.5, AC1.6, AC1.7).
 *
 * Two layers:
 *   1. Catalog rules over a direct Postgres connection. The table list comes
 *      from the catalog, not from this file, so a brand table added later is
 *      checked automatically. A mutation check proves the rules really fail
 *      when RLS is weakened or an unprotected table appears (rolled back).
 *   2. Real sessions through the public API key: one throwaway analyst per
 *      brand signs in with a password and asks every brand table, dashboard
 *      function and Storage folder for other brands' data; a signed-out client
 *      asks for everything. Nothing may come back.
 *
 * Live setup and cleanup: see tests/live.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLive, liveConfigured, type Live, type Member } from "./live";

// The only public table allowed to lack brand_id; it is still scoped to the caller's own brand.
const UNBRANDED = new Set(["brands"]);
const DASHBOARD_RPCS = ["dashboard_totals", "dashboard_contactable_breakdown", "dashboard_signups_per_day", "dashboard_campaign_performance"];

// One row per rule broken. Empty means isolated.
const VIOLATIONS_SQL = `
  with rel as (
    select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'brand_id' and not a.attisdropped) as has_brand
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  )
  select relname, 'view or materialized view readable by API roles without security_invoker' as rule from rel
    where relkind in ('v', 'm', 'f')
      and (has_table_privilege('anon', oid, 'select') or has_table_privilege('authenticated', oid, 'select'))
      and not coalesce('security_invoker=true' = any (reloptions) or 'security_invoker=on' = any (reloptions), false)
  union all
  select relname, 'table without brand_id' from rel
    where relkind in ('r', 'p') and not has_brand and relname <> all ($1::text[])
  union all
  select relname, 'row level security not enabled' from rel where relkind in ('r', 'p') and not relrowsecurity
  union all
  select relname, 'row level security not forced' from rel where relkind in ('r', 'p') and not relforcerowsecurity
  union all
  select relname, 'no policy' from rel
    where relkind in ('r', 'p') and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = rel.relname)
  union all
  select p.tablename, 'policy ' || p.policyname || ' not scoped to current_brand_id()' from pg_policies p
    where p.schemaname = 'public'
      and coalesce(p.qual, '') || coalesce(p.with_check, '') not like '%current_brand_id()%'
  union all
  select p.tablename, 'policy ' || p.policyname || ' applies to a role other than authenticated' from pg_policies p
    where p.schemaname = 'public' and p.roles <> '{authenticated}'
  union all
  select relname, 'anon has a privilege' from rel
    where relkind in ('r', 'p')
      and (has_table_privilege('anon', oid, 'select') or has_table_privilege('anon', oid, 'insert')
        or has_table_privilege('anon', oid, 'update') or has_table_privilege('anon', oid, 'delete'))
  union all
  select relname, 'authenticated can write directly' from rel
    where relkind in ('r', 'p')
      and (has_table_privilege('authenticated', oid, 'insert') or has_table_privilege('authenticated', oid, 'update')
        or has_table_privilege('authenticated', oid, 'delete') or has_table_privilege('authenticated', oid, 'truncate'))
  order by 1, 2`;

describe.skipIf(!liveConfigured)("brand isolation (live project)", { timeout: 60_000 }, () => {
  let live: Live;
  let db: Live["db"];
  let admin: Live["admin"];
  let brandTables: string[];
  const users: Member[] = [];

  beforeAll(async () => {
    live = await connectLive("isolation");
    ({ db, admin } = live);
    brandTables = (
      await db.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'brand_id' and not a.attisdropped)
        order by 1`)
    ).rows.map((r) => r.relname);

    for (const brand of live.brands) users.push(await live.createMember(brand.code, "analyst"));
  });

  afterAll(async () => {
    await live?.close();
  });

  it("every public table satisfies the isolation rules", async () => {
    const { rows } = await db.query(VIOLATIONS_SQL, [[...UNBRANDED]]);
    expect(rows).toEqual([]);
  });

  it("the rules fail when isolation is weakened or an unprotected table is added", async () => {
    await db.query("begin");
    try {
      await db.query("alter table public.contacts no force row level security");
      await db.query("alter table public.campaigns disable row level security");
      await db.query("create table public.isolation_probe (id int)");
      await db.query("create table public.isolation_probe_branded (brand_id uuid)");
      await db.query("grant select on public.isolation_probe_branded to anon");
      const { rows } = await db.query(VIOLATIONS_SQL, [[...UNBRANDED]]);
      expect(rows).toEqual(
        expect.arrayContaining([
          { relname: "contacts", rule: "row level security not forced" },
          { relname: "campaigns", rule: "row level security not enabled" },
          { relname: "isolation_probe", rule: "table without brand_id" },
          // The project enables (but does not force) RLS on new tables by itself.
          { relname: "isolation_probe_branded", rule: "row level security not forced" },
          { relname: "isolation_probe_branded", rule: "no policy" },
          { relname: "isolation_probe_branded", rule: "anon has a privilege" },
        ]),
      );
    } finally {
      await db.query("rollback");
    }
  });

  it("each test user sees only members of its own brand, itself included", async () => {
    for (const u of users) {
      const { data, error } = await u.client.from("brand_members").select("user_id, brand_id");
      expect(error).toBeNull();
      expect(data).toContainEqual({ user_id: u.userId, brand_id: u.brand.id });
      expect(data!.every((m) => m.brand_id === u.brand.id)).toBe(true);
    }
  });

  it("a signed-in user gets no other brand's rows from any brand table (AC1.5)", async () => {
    expect(brandTables.length).toBeGreaterThan(0);
    for (const u of users) {
      const own = await u.client.from("brands").select("id");
      expect(own.error).toBeNull();
      expect(own.data).toEqual([{ id: u.brand.id }]);

      for (const table of brandTables) {
        const foreign = await u.client.from(table).select("brand_id").neq("brand_id", u.brand.id).limit(1);
        expect(foreign.error, `${u.brand.code} reading ${table}`).toBeNull();
        expect(foreign.data, `${u.brand.code} got foreign rows from ${table}`).toEqual([]);
      }
    }
  });

  it("the brand filter is not what hides other brands: other brands' ids return nothing (AC1.5)", async () => {
    const [a, b] = users;
    for (const table of ["contacts", "campaigns", "engagement_events", "import_runs"]) {
      const { count: truth } = await admin.from(table).select("*", { count: "exact", head: true }).eq("brand_id", b.brand.id);
      const asA = await a.client.from(table).select("brand_id").eq("brand_id", b.brand.id).limit(1);
      expect(asA.error).toBeNull();
      expect(asA.data, `${a.brand.code} asked ${table} for ${b.brand.code} (which has ${truth} rows)`).toEqual([]);
    }
  });

  it("dashboard functions only describe the caller's brand (AC1.5)", async () => {
    for (const u of users) {
      const totals = await u.client.rpc("dashboard_totals");
      expect(totals.error).toBeNull();
      const { count } = await admin.from("contacts").select("*", { count: "exact", head: true }).eq("brand_id", u.brand.id);
      expect(totals.data).toHaveLength(1);
      expect(Number(totals.data[0].total_customers)).toBe(count);

      const perf = await u.client.rpc("dashboard_campaign_performance");
      expect(perf.error).toBeNull();
      const { data: ownCampaigns } = await admin.from("campaigns").select("id").eq("brand_id", u.brand.id);
      expect(perf.data.map((r: { campaign_id: number }) => r.campaign_id).sort()).toEqual(ownCampaigns!.map((c) => c.id).sort());
    }
  });

  it("uploaded files of other brands cannot be listed or downloaded (AC1.5)", async () => {
    const [a, b] = users;
    const { data: bFiles } = await admin.storage.from("imports").list(b.brand.id, { limit: 1 });
    const listed = await a.client.storage.from("imports").list(b.brand.id, { limit: 10 });
    expect(listed.data ?? []).toEqual([]);
    if (bFiles?.length) {
      const download = await a.client.storage.from("imports").download(`${b.brand.id}/${bFiles[0].name}`);
      expect(download.data).toBeNull();
    }
  });

  it("a signed-in user cannot write brand data directly", async () => {
    const [a] = users;
    const insert = await a.client.from("contacts").insert({ brand_id: a.brand.id, external_id: "X", status: "active", row_hash: "x" });
    expect(insert.error).not.toBeNull();
    const update = await a.client.from("campaigns").update({ name: "hijacked" }).eq("brand_id", a.brand.id).select("id");
    expect(update.error).not.toBeNull();
  });

  it("signed-out requests get nothing from any table or dashboard function (AC1.6)", async () => {
    const anon = live.newClient();
    for (const table of [...UNBRANDED, ...brandTables]) {
      const { data } = await anon.from(table).select("*").limit(1);
      expect(data ?? [], `anon read ${table}`).toEqual([]);
    }
    for (const fn of DASHBOARD_RPCS) {
      const { data, error } = await anon.rpc(fn);
      expect(error, `anon called ${fn}`).not.toBeNull();
      expect(data).toBeNull();
    }
    const listed = await anon.storage.from("imports").list(users[0].brand.id, { limit: 1 });
    expect(listed.data ?? []).toEqual([]);
  });
});
