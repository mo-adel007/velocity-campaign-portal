"use client";

/**
 * Owner upload: the browser sends the file straight to the brand's Storage
 * folder (server action bodies are too small for exports), then asks the
 * server to queue it. Storage policies and `request_import` both check the
 * caller is an owner of this brand.
 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass, Notice } from "@/components/ui";
import { createClient } from "@/lib/supabase/browser";
import { requestImport } from "./actions";

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadForm({ brandId }: { brandId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "critical"; text: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return setMessage({ tone: "critical", text: "Choose a file first." });
    if (file.size === 0) return setMessage({ tone: "critical", text: "This file is empty." });
    if (file.size > MAX_BYTES) return setMessage({ tone: "critical", text: "Files can be at most 50 MB." });

    setBusy(true);
    setMessage(null);
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
    const path = `${brandId}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await createClient().storage.from("imports").upload(path, file, { contentType: "text/csv", upsert: false });
    if (uploadError) {
      setBusy(false);
      return setMessage({ tone: "critical", text: "The file could not be uploaded. Nothing was loaded. Please try again." });
    }
    const result = await requestImport(path, file.name);
    setBusy(false);
    if (result.error) return setMessage({ tone: "critical", text: result.error });
    setMessage({ tone: "good", text: `“${file.name}” is queued. Its result and any rejected rows appear below.` });
    setFile(null);
    formRef.current?.reset();
    router.refresh();
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-3">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <label className="block text-sm">
        <span className="mb-1 block text-ink-2">Contacts, campaigns, events or send-log export (CSV, up to 50 MB)</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-0 file:px-3 file:py-1.5"
        />
      </label>
      <button type="submit" disabled={busy || !file} className={buttonClass}>
        {busy ? "Uploading…" : "Upload and load"}
      </button>
    </form>
  );
}
