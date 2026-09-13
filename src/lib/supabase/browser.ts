/**
 * Supabase client in the browser, as the signed-in user. Used only where the
 * browser must talk to Supabase directly: uploading large files to Storage.
 */
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
