import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState title="Not found">
      This page does not exist in your brand&apos;s portal. <Link href="/" className="text-accent-ink underline">Back to the dashboard</Link>
    </EmptyState>
  );
}
