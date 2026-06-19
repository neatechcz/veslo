import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="ow-legal-shell">
      <div className="ow-legal-container">
        <nav className="ow-legal-nav" aria-label="Veslo legal navigation">
          <Link href="/">Veslo</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </nav>

        <article className="ow-legal-doc">
          <p className="ow-legal-kicker">Effective date: June 19, 2026</p>
          <h1>Terms</h1>
          <p>
            Veslo is operated by Neatech. These terms apply to app.veslo.work, api.veslo.work, and Veslo cloud
            services.
          </p>

          <h2>Use of Veslo</h2>
          <p>
            You are responsible for the actions you run through Veslo and for ensuring that your use complies with
            applicable law, your organization&apos;s policies, and any third-party service terms that apply.
          </p>

          <h2>Optional Connectors</h2>
          <p>
            Veslo may offer optional connectors for services such as Google Workspace. Connectors operate only after
            you authorize the requested permissions. You can revoke connector access from Veslo or from the connected
            third-party account.
          </p>

          <h2>Accounts and Security</h2>
          <p>
            You must keep your Veslo account and connected accounts secure. Notify us if you believe your account or
            connector authorization has been compromised.
          </p>

          <h2>Service Changes</h2>
          <p>
            Veslo may change, suspend, or discontinue parts of the service. We may update these terms when the
            service changes or when legal, operational, or security requirements change.
          </p>

          <h2>Disclaimers</h2>
          <p>
            Veslo is provided as available. To the extent permitted by law, Veslo disclaims warranties of
            merchantability, fitness for a particular purpose, and non-infringement.
          </p>

          <h2>Contact</h2>
          <p>Questions about these terms can be sent to vaclav.soukup@neatech.cz.</p>
        </article>
      </div>
    </main>
  );
}
