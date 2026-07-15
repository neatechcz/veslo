import { createApp, type AppDependencies } from "./index.js";

/**
 * Supported integration-test entry point for consumers outside the AI Gateway
 * owner. It deliberately exposes only app construction, so tests must use
 * public HTTP behaviour instead of importing implementation modules.
 */
export function createAiGatewayTestApp(dependencies: AppDependencies) {
  return createApp(dependencies);
}
