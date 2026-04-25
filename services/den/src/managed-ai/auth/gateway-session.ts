import { DenUserSessionResolver, type UserSession, type UserSessionResolver } from "./user-session.js"

export type GatewaySession = UserSession

export interface GatewaySessionResolver {
  resolveSession(token: string): Promise<GatewaySession | null>
}

export class DenGatewaySessionResolver implements GatewaySessionResolver {
  private readonly delegate: UserSessionResolver

  constructor(delegate: UserSessionResolver = new DenUserSessionResolver()) {
    this.delegate = delegate
  }

  resolveSession(token: string): Promise<GatewaySession | null> {
    return this.delegate.resolveSession(token)
  }
}
