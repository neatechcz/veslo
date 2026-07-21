export class SignupOrganizationDomainConflictError extends Error {
  constructor(readonly domain: string, options?: ErrorOptions) {
    super("signup_organization_domain_conflict", options)
    this.name = "SignupOrganizationDomainConflictError"
  }
}
