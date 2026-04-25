import { DenUserSessionResolver, type DenUserSessionResolverDeps, type UserSession } from "./user-session.js";

export type GatewaySession = UserSession;

export interface GatewaySessionResolver {
  resolveSession(token: string): Promise<GatewaySession | null>;
}

export class DenGatewaySessionResolver implements GatewaySessionResolver {
  private readonly delegate: DenUserSessionResolver;

  constructor(deps: DenUserSessionResolverDeps) {
    this.delegate = new DenUserSessionResolver(deps);
  }

  resolveSession(token: string): Promise<GatewaySession | null> {
    return this.delegate.resolveSession(token);
  }
}
