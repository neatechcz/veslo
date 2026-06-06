export function normalizeInviteEmail(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return normalized.includes("@") && normalized.split("@")[1]?.length ? normalized : null
}

export function normalizeEmailDomain(value: unknown) {
  const email = normalizeInviteEmail(value)
  if (!email) return null
  const domain = email.split("@").pop()?.trim().toLowerCase()
  return domain || null
}

export function canActivateSeat(input: { activeSeats: number; seatLimit: number | null }) {
  if (input.seatLimit === null) return true
  return input.activeSeats < input.seatLimit
}
