export type SessionContext = {
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    name: string | null
  }
}
