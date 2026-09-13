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
 * Needs SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD
 * (run with `node scripts/env-run.mjs vitest run tests/isolation.test.ts`) and a
 * linked project (`supabase/.temp/pooler-url`). Skipped when they are missing.
 * Test users and their allowlist rows are removed afterwards.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const env = process.env;
const poolerFile = path.join(__dirname, "..", "supabase", ".temp", "pooler-url");
const configured = Boolean(env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECT_REF && env.SUPABASE_DB_PASSWORD && existsSync(poolerFile));

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

describe.skipIf(!configured)("brand isolation (live project)", { timeout: 60_000 }, () => {
  const ref = env.SUPABASE_PROJECT_REF!;
  const url = `https://${ref}.supabase.co`;
  // Realtime is never used; the stub transport only lets supabase-js start on Node 20.
  const opts = { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: class {} } } as const;
  const runId = randomBytes(4).toString("hex");

  let db: pg.Client;
  let admin: SupabaseClient;
  let publicKey: string;
  let brands: { id: string; code: string }[];
  let brandTables: string[];
  const users: { brand: { id: string; code: string }; userId: string; email: string; client: SupabaseClient }[] = [];

  beforeAll(async () => {
    const pooler = new URL(readFileSync(poolerFile, "utf8").trim());
    db = new pg.Client({
      host: pooler.hostname, port: Number(pooler.port), database: pooler.pathname.slice(1),
      user: decodeURIComponent(pooler.username), password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
    });
    await db.connect();

    const keys: { type: string; name: string; api_key: string }[] = await fetch(
      `https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
      { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } },
    ).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`api-keys: ${r.status}`))));
    const pick = (type: string, legacy: string) => (keys.find((k) => k.type === type) ?? keys.find((k) => k.name === legacy))?.api_key;
    publicKey = pick("publishable", "anon")!;
    admin = createClient(url, pick("secret", "service_role")!, opts);

    brands = (await db.query("select id, code from public.brands order by code")).rows;
    brandTables = (
      await db.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'brand_id' and not a.attisdropped)
        order by 1`)
    ).rows.map((r) => r.relname);

    for (const brand of brands) {
      const email = `vcp-isolation-${runId}-${brand.code.toLowerCase()}@example.com`;
      const password = randomBytes(18).toString("base64url");
      await db.query("insert into private.allowed_users (email, brand_id, role) values ($1, $2, 'analyst')", [email, brand.id]);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      const client = createClient(url, publicKey, opts);
      const signIn = await client.auth.signInWithPassword({ email, password });
      if (signIn.error) throw signIn.error;
      users.push({ brand, userId: data.user.id, email, client });
    }
  });

  afterAll(async () => {
    for (const u of users) await admin?.auth.admin.deleteUser(u.userId);
    await db?.query("delete from private.allowed_users where email like $1", [`vcp-isolation-${runId}-%`]);
    await db?.end();
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

  it("each test user belongs to exactly its own brand", async () => {
    for (const u of users) {
      const { data, error } = await u.client.from("brand_members").select("user_id, brand_id");
      expect(error).toBeNull();
      expect(data).toEqual([{ user_id: u.userId, brand_id: u.brand.id }]);
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
    const anon = createClient(url, publicKey, opts);
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
