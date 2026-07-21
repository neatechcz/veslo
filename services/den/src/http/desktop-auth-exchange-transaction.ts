export type DesktopExchangeTransactionFailure = {
  ok: false
  status: number
  error: string
}

class DesktopExchangeTransactionAbort extends Error {
  readonly failure: DesktopExchangeTransactionFailure

  constructor(failure: DesktopExchangeTransactionFailure) {
    super(`Desktop exchange transaction aborted: ${failure.error}`)
    this.name = "DesktopExchangeTransactionAbort"
    this.failure = failure
  }
}

export function abortDesktopExchangeTransaction(
  failure: DesktopExchangeTransactionFailure,
): never {
  throw new DesktopExchangeTransactionAbort(failure)
}

export function readDesktopExchangeTransactionFailure(
  error: unknown,
): DesktopExchangeTransactionFailure | null {
  return error instanceof DesktopExchangeTransactionAbort ? error.failure : null
}
