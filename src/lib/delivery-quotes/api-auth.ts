import { auth } from "@/auth";
import { isAllowedAdminGithubId } from "./admin-auth";

export class AdminAuthenticationError extends Error {
  constructor() {
    super("Требуется авторизация администратора.");
    this.name = "AdminAuthenticationError";
  }
}

export async function requireAdminActor(): Promise<string> {
  const session = await auth();
  const id = session?.user?.githubUserId;
  if (!isAllowedAdminGithubId(id)) throw new AdminAuthenticationError();
  return id;
}
