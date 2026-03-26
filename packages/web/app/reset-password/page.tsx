"use client";

import { FormEvent, useEffect, useState } from "react";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    setToken(searchParams.get("token") ?? "");
    setError(searchParams.get("error") ?? null);
  }, []);

  const canSubmit = token.trim().length > 0 && !done;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          token,
          newPassword
        })
      });

      if (!response.ok) {
        const payload = await response.text();
        setError(payload.trim() || `Reset failed with ${response.status}.`);
        return;
      }

      setDone(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unknown network error");
    } finally {
      setBusy(false);
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
              <span className="ow-icon-chip">RP</span>
              <h1 className="ow-title">Choose a new password</h1>
              <p className="ow-subtitle">
                Enter the password reset token from your email and pick a new password for the account.
              </p>
            </div>

            {error ? (
              <div className="ow-note-box">
                <p className="ow-error-text">{error}</p>
                <p>
                  If the token expired, request a new reset link from the forgot-password page and use the latest email.
                </p>
              </div>
            ) : null}

            {done ? (
              <div className="ow-note-box">
                <p>Your password has been updated.</p>
                <p>
                  Return to the sign-in screen and use the new password the next time you log in.
                </p>
              </div>
            ) : (
              <form className="ow-stack" onSubmit={handleSubmit}>
                <label className="ow-field-block">
                  <span className="ow-field-label">Reset token</span>
                  <input className="ow-input ow-mono" type="text" value={token} readOnly />
                </label>

                <label className="ow-field-block">
                  <span className="ow-field-label">New password</span>
                  <input
                    className="ow-input"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>

                <button type="submit" className="ow-btn-primary" disabled={busy || !canSubmit}>
                  {busy ? "Updating..." : "Update password"}
                </button>
              </form>
            )}

            <div className="ow-inline-row">
              <p className="ow-caption">Need a new link?</p>
              <a href="/forgot-password" className="ow-link">
                Request password reset
              </a>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
