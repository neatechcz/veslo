import type { UpstreamAuth } from "../credentials/token-broker.js";

export type ChatCompletionsTransportInput = {
  upstreamAuth: UpstreamAuth;
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
