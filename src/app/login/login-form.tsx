"use client";

import { useActionState } from "react";
import { buttonClass, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { signInWithGoogle, signInWithPassword, type SignInState } from "./actions";

export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, passwordAction, signingIn] = useActionState(signInWithPassword, { error: initialError } as SignInState);
  const [googleState, googleAction, redirecting] = useActionState(signInWithGoogle, {} as SignInState);
  const error = state.error ?? googleState.error;

  return (
    <div className="space-y-5">
      {error && <Notice tone="critical">{error}</Notice>}
      <form action={passwordAction} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-2">Email</span>
          <input name="email" type="email" autoComplete="email" required className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-2">Password</span>
          <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
        </label>
        <button type="submit" disabled={signingIn || redirecting} className={`${buttonClass} w-full`}>
          {signingIn ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="flex items-center gap-3 text-xs text-ink-3">
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>
      <form action={googleAction}>
        <button type="submit" disabled={signingIn || redirecting} className={`${secondaryButtonClass} w-full`}>
          {redirecting ? "Opening Google…" : "Continue with Google"}
        </button>
      </form>
    </div>
  );
}
