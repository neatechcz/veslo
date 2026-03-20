export function shouldUseEmailCustomerFallback(input: { email: string; emailVerified: boolean }) {
  return input.emailVerified && input.email.trim().length > 0
}
