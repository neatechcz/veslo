export type UpstreamAuth = {
  kind: "api-key" | "oauth"
  value: string
}

export type GetUpstreamAuthInput = {
  bindingId: string
}

export interface TokenBroker {
  getUpstreamAuth(input: GetUpstreamAuthInput): Promise<UpstreamAuth>
}
