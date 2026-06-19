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

      <CloudControlPanel />

      <footer className="ow-public-footer">
        <Link href="/privacy">Privacy Policy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </main>
  );
}
