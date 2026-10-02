import type { Metadata } from "next";
import { CommandCenter } from "@/components/command-center";

export const metadata: Metadata = {
  title: "Command Center",
  description:
    "The authenticated PaySwap Command Center. Authentication is required and not yet available in this deployment phase — this entry renders the honest gate, with no demo data and no pretend login.",
};

/**
 * Optional catch-all: /app itself and every /app/* deep link render the
 * Command Center shell with the honest authentication gate. A hard refresh
 * on any /app/* path re-renders this route server-side — no client-only
 * 404s.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  return <CommandCenter section={section} />;
}
