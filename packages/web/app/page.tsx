import { CloudControlPanel } from "../components/cloud-control";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="ow-shell">
      <div className="ow-ambient" aria-hidden>
        <span className="ow-blob ow-blob-one" />
        <span className="ow-blob ow-blob-two" />
        <span className="ow-blob ow-blob-three" />
      </div>

      <header className="ow-brand">
        <span className="ow-brand-icon" aria-hidden>
          <span className="ow-brand-icon-core" />
        </span>
        <span className="ow-brand-text">Veslo</span>
      </header>

      <section className="ow-public-intro" aria-labelledby="veslo-purpose">
        <p className="ow-public-kicker">Veslo Cloud</p>
        <h1 id="veslo-purpose">A control surface for agentic work</h1>
        <p>
          Veslo helps users and teams connect work tools to private agent workspaces, run agent workflows, and
          keep control over the services they authorize. Optional Google Workspace connectors let a user connect
          Gmail, Calendar, and Drive so Veslo can read, summarize, search, or draft content only for actions the
          user requests.
        </p>
        <p>
          Google Workspace access is user-authorized with OAuth. Users can disconnect connectors in Veslo or revoke
          access from their Google Account permissions at any time.
        </p>
        <div className="ow-public-actions" aria-label="Veslo public links">
          <a href="#cloud-control">Open cloud control</a>
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </section>

      <div id="cloud-control" className="ow-cloud-control-anchor">
        <CloudControlPanel />
      </div>

      <footer className="ow-public-footer">
        <Link href="/privacy">Privacy Policy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </main>
  );
}
