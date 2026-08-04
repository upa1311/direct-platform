import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";

import { isAllowedAdminGithubId } from "@/lib/delivery-quotes/admin-auth";

const e2eProvider = process.env.QUOTE_E2E_MODE === "1"
  && process.env.AUTH_E2E_CREDENTIAL_SECRET
  && process.env.VERCEL_ENV !== "production"
  ? Credentials({
      id: "e2e",
      name: "Локальный E2E",
      credentials: {
        githubUserId: { label: "GitHub user ID", type: "text" },
        secret: { label: "E2E secret", type: "password" },
      },
      authorize(credentials) {
        const id = String(credentials.githubUserId ?? "");
        const secret = String(credentials.secret ?? "");
        if (
          secret !== process.env.AUTH_E2E_CREDENTIAL_SECRET
          || !isAllowedAdminGithubId(id)
        ) return null;
        return { id, name: "E2E Administrator" };
      },
    })
  : null;

export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [GitHub, ...(e2eProvider ? [e2eProvider] : [])],
  pages: { signIn: "/admin/delivery-quote-login" },
  session: { strategy: "jwt", maxAge: 60 * 60 },
  callbacks: {
    async signIn({ account, profile, user }) {
      const githubUserId = account?.provider === "github"
        ? String(profile?.id ?? user.id ?? "")
        : String(user.id ?? "");
      user.id = githubUserId;
      return isAllowedAdminGithubId(githubUserId);
    },
    async jwt({ token, account, profile, user }) {
      if (account?.provider === "github") {
        token.githubUserId = String(profile?.id ?? user?.id ?? "");
      } else if (user?.id) {
        token.githubUserId = String(user.id);
      }
      return token;
    },
    async session({ session, token }) {
      session.user.githubUserId = String(token.githubUserId ?? "");
      return session;
    },
    authorized({ auth: session }) {
      return isAllowedAdminGithubId(session?.user?.githubUserId);
    },
  },
});
