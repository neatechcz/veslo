"use client";

import { useEffect, useState } from "react";

export default function VerifyEmailPage() {
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    setError(searchParams.get("error") ?? "");
  }, []);

  return (
    <main className="ow-shell">
      <div className="ow-ambient" aria-hidden="true">
        <span className="ow-blob ow-blob-one" />
        <span className="ow-blob ow-blob-two" />
        <span className="ow-blob ow-blob-three" />
      </div>

      <a href="/" className="ow-brand">
        <span className="ow-brand-icon">
          <span className="ow-brand-icon-core" />
        </span>
        <span className="ow-brand-text">Veslo</span>
      </a>

      <section className="ow-card">
        <div className="ow-card-body">
          <div className="ow-stack">
            <div className="ow-heading-block">
              <span className="ow-icon-chip">VE</span>
              <h1 className="ow-title">{error ? "Verification needs attention" : "Email verified"}</h1>
              <p className="ow-subtitle">
                {error
                  ? "The link could not be completed. Use the latest verification email or ask Veslo to send another one."
                  : "Your email address is verified and ready for the next step."}
              </p>
            </div>

            <div className="ow-note-box">
              {error ? (
                <>
                  <p className="ow-error-text">{error}</p>
                  <p>
                    Go back to Veslo, sign in again, and use the resend verification action if the message expired.
                  </p>
                </>
              ) : (
                <>
                  <p>Verification succeeded.</p>
                  <p>
                    Return to Veslo and continue with your cloud worker setup or sign in flow.
                  </p>
                </>
              )}
            </div>

            <div className="ow-inline-row">
              <p className="ow-caption">Next step</p>
              <a href="/" className="ow-link">
                Return to Veslo
              </a>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
