/**
 * Shell for every signed-in screen: brand, role, navigation and sign out.
 * `getPortal()` sends visitors without a session or brand membership away
 * before any page below renders.
 */
import { signOut } from "@/app/login/actions";
import { Badge } from "@/components/ui";
import { getPortal } from "@/lib/portal";
import { PortalNav } from "./nav";

export default async function PortalLayout({ children }: LayoutProps<"/">) {
  const portal = await getPortal();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface-1">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">{portal.brand.name}</p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <span className="truncate">{portal.email}</span>
              <Badge tone={portal.role === "owner" ? "accent" : "neutral"}>{portal.role === "owner" ? "Owner" : "Analyst"}</Badge>
            </p>
          </div>
          <form action={signOut}>
            <button type="submit" className="text-sm text-ink-2 hover:text-ink">
              Sign out
            </button>
          </form>
          <PortalNav />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
