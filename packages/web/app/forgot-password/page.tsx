"use client";

import { FormEvent, useState } from "react";
import { buildAuthCallbackUrl } from "../../lib/auth-urls";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    "If the address exists, we will send a reset link without revealing whether it is registered."
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || busy) {
      return;
    }

    setBusy(true);
    try {
      await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: trimmedEmail,
          redirectTo: buildAuthCallbackUrl("/reset-password")
        })
      });
    } catch {
      // Keep the confirmation neutral even if the request cannot be observed.
    } finally {
      setBusy(false);
      setStatus("If the address exists, a password reset link will arrive shortly.");
    }
  }

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
              <span className="ow-icon-chip">FP</span>
              <h1 className="ow-title">Reset your password</h1>
              <p className="ow-subtitle">
                Request a private reset link. We keep the response neutral so the page does not reveal account details.
              </p>
            </div>

            <form className="ow-stack" onSubmit={handleSubmit}>
              <label className="ow-field-block">
                <span className="ow-field-label">Email</span>
                <input
                  className="ow-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>

              <button type="submit" className="ow-btn-primary" disabled={busy}>
                {busy ? "Sending..." : "Send reset link"}
              </button>
            </form>

            <div className="ow-note-box">
              <p>{status}</p>
            </div>

            <div className="ow-inline-row">
              <p className="ow-caption">Already have access?</p>
              <a href="/" className="ow-link">
                Return to sign in
              </a>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
