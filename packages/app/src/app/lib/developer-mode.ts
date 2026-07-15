const ENABLED_DEVELOPER_MODE_VALUES = new Set(["", "1", "true", "yes", "on"]);

export function resolveDeveloperModeFromSearch(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has("debug")) return false;
  const value = params.get("debug")?.trim().toLowerCase() ?? "";
  return ENABLED_DEVELOPER_MODE_VALUES.has(value);
}

export function resolveDeveloperModeFromWindowLocation(
  location: Pick<Location, "hash" | "search">,
): boolean {
  if (resolveDeveloperModeFromSearch(location.search)) return true;

  const hashQueryStart = location.hash.indexOf("?");
  if (hashQueryStart < 0) return false;
  return resolveDeveloperModeFromSearch(location.hash.slice(hashQueryStart));
}
