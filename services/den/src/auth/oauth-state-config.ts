import type { BetterAuthOptions } from "better-auth"

export const betterAuthAccountOptions = {
  storeStateStrategy: "cookie",
} as const satisfies NonNullable<BetterAuthOptions["account"]>
