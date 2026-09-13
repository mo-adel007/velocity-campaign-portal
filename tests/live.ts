/**
 * Shared setup for tests that run against the live project: a direct Postgres
 * connection, the API keys, and throwaway brand members that sign in with a
 * password through the public key exactly like a real user.
 *
 * Needs SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD
 * (run tests with `node scripts/env-run.mjs vitest run`) and a linked project
 * (`supabase/.temp/pooler-url`). Suites use `describe.skipIf(!liveConfigured)`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

const env = process.env;
const poolerFile = path.join(__dirname, "..", "supabase", ".temp", "pooler-url");

export const liveConfigured = Boolean(
  env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECT_REF && env.SUPABASE_DB_PASSWORD && existsSync(poolerFile),
);

export interface Brand {
  id: string;
  code: string;
}

export interface Member {
  brand: Brand;
  role: "owner" | "analyst";
  userId: string;
  email: string;
  password: string;
  client: SupabaseClient;
}

export interface Live {
  db: pg.Client;
  admin: SupabaseClient;
  url: string;
  publicKey: string;
  brands: Brand[];
  newClient(): SupabaseClient;
  createMember(brandCode: string, role: Member["role"]): Promise<Member>;
  close(): Promise<void>;
}

export async function connectLive(tag: string): Promise<Live> {
  const ref = env.SUPABASE_PROJECT_REF!;
  const url = `https://${ref}.supabase.co`;
  // Realtime is never used; the stub transport only lets supabase-js start on Node 20.
  const opts = { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: class {} } } as const;

  const pooler = new URL(readFileSync(poolerFile, "utf8").trim());
  const db = new pg.Client({
    host: pooler.hostname,
    port: Number(pooler.port),
    database: pooler.pathname.slice(1),
    user: decodeURIComponent(pooler.username),
    password: env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const keys: { type: string; name: string; api_key: string }[] = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } },
  ).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`api-keys: ${r.status}`))));
  const pick = (type: string, legacy: string) => (keys.find((k) => k.type === type) ?? keys.find((k) => k.name === legacy))?.api_key;
  const publicKey = pick("publishable", "anon")!;
  const admin = createClient(url, pick("secret", "service_role")!, opts);
  const brands: Brand[] = (await db.query("select id, code from public.brands order by code")).rows;

  // Emails carry a per-run prefix so cleanup never touches anyone else.
  const prefix = `vcp-${tag}-${randomBytes(4).toString("hex")}-`;
  const members: Member[] = [];
  const newClient = () => createClient(url, publicKey, opts);

  return {
    db,
    admin,
    url,
    publicKey,
    brands,
    newClient,
    async createMember(brandCode, role) {
      const brand = brands.find((b) => b.code === brandCode)!;
      const email = `${prefix}${brandCode.toLowerCase()}-${role}@example.com`;
      const password = randomBytes(18).toString("base64url");
      await db.query("insert into private.allowed_users (email, brand_id, role) values ($1, $2, $3)", [email, brand.id, role]);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      const client = newClient();
      const signIn = await client.auth.signInWithPassword({ email, password });
      if (signIn.error) throw signIn.error;
      const member = { brand, role, userId: data.user.id, email, password, client };
      members.push(member);
      return member;
    },
    async close() {
      for (const m of members) await admin.auth.admin.deleteUser(m.userId);
      await db.query("delete from private.allowed_users where email like $1", [`${prefix}%`]);
      await db.end();
    },
  };
}
