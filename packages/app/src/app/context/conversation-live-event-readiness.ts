export function hasConversationLiveEventRoute(info: {
  baseUrl?: string | null;
}): boolean {
  return Boolean(info.baseUrl?.trim());
}
