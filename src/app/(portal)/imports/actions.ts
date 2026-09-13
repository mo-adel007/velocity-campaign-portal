"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export interface ImportState {
  error?: string;
  runId?: number;
}

/**
 * Queues a file the browser has already put into Storage. `request_import`
 * refuses non-owners, paths outside the caller's brand folder and missing
 * files; the worker then parses it and refuses wrong-brand or unreadable files.
 */
export async function requestImport(storagePath: string, fileName: string): Promise<ImportState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_import", { p_storage_path: storagePath, p_file_name: fileName });
  if (error) return { error: actionError(error) };
  revalidatePath("/imports");
  return { runId: data as number };
}
