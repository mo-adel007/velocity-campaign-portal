/**
 * The signed-in member and their brand, resolved once per request. Pages call
 * `getPortal()`; a visitor without a session goes to /login, and a signed-in
 * account without a brand membership sees "no access" rather than an empty
 * portal.
 */
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export interface Portal {
  userId: string;
  email: string;
  role: "owner" | "analyst";
  brand: { id: string; code: string; name: string; timezone: string };
}

export const getPortal = cache(async (): Promise<Portal> => {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims) redirect("/login");

  const { data, error } = await supabase
    .from("brand_members")
    .select("role, email, brands(id, code, name, timezone)")
    .eq("user_id", auth.claims.sub)
    .maybeSingle();
  if (error) throw new Error(`Could not load your portal: ${error.message}`);
  if (!data?.brands) redirect("/login?error=no_access");

  const brand = data.brands as unknown as Portal["brand"];
  return { userId: auth.claims.sub, email: data.email, role: data.role as Portal["role"], brand };
});
