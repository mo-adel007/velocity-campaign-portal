import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  no_access: "This account has no access to a brand portal. Ask your Velocity Growth contact to add it.",
  auth: "Sign-in did not complete. Accounts that are not authorised for this portal are refused.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? (ERRORS[error] ?? ERRORS.auth) : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="text-sm font-medium text-accent-ink">Velocity Growth</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Campaign Portal</h1>
        <p className="mt-1 mb-6 text-sm text-ink-2">Sign in to see your brand&apos;s contacts, campaigns and results.</p>
        <div className="rounded-xl border border-line bg-surface-1 p-5">
          <LoginForm initialError={message} />
        </div>
      </div>
    </main>
  );
}
