import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { isAllowedAdminGithubId } from "@/lib/delivery-quotes/admin-auth";

export default async function DeliveryQuotesLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!isAllowedAdminGithubId(session?.user?.githubUserId)) {
    redirect("/admin/delivery-quote-login");
  }
  return children;
}
