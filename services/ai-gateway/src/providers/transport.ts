export type ChatCompletionsTransportInput = {
  authValue: string;
  body: unknown;
};

export type ProviderTransportResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export interface ProviderTransport {
  chatCompletions(input: ChatCompletionsTransportInput): Promise<ProviderTransportResponse>;
}
