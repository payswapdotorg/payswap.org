import type { Metadata } from "next";
import { DevelopersPage } from "@/components/developers-page";
import { apiRuntimeState } from "@/lib/api";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "The PaySwap API is the authority — the same protocol path serves the product UI and programmatic clients. Enveloped responses, enforced idempotency, signed webhooks, and UNKNOWN outcomes that stay UNKNOWN.",
};

export default function Page() {
  return <DevelopersPage api={apiRuntimeState()} />;
}
