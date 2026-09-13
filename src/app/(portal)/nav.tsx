"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/contacts", label: "Contacts" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
];

export function PortalNav() {
  const path = usePathname();
  const active = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href) || (href === "/campaigns" && path.startsWith("/sends"));
  return (
    <nav aria-label="Portal" className="-mx-1 flex w-full gap-1 overflow-x-auto text-sm">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={active(l.href) ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 whitespace-nowrap ${active(l.href) ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-0"}`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
