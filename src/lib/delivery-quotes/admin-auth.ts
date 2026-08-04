export function configuredAdminGithubIds(): ReadonlySet<string> {
  return new Set(
    (process.env.ADMIN_GITHUB_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value)),
  );
}

export function isAllowedAdminGithubId(value: unknown): value is string {
  return typeof value === "string" && configuredAdminGithubIds().has(value);
}
