"use client";

import { useMemo, useState } from "react";

type Props = {
  calUrl: string;
};

const buildCalUrl = (baseUrl: string, params: Record<string, string>) => {
  try {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (!value) continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
};

export function BookCallForm(props: Props) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  const href = useMemo(() => {
    if (!props.calUrl) return "";
    return buildCalUrl(props.calUrl, {
      email,
      company
    });
  }, [props.calUrl, email, company]);

  return (
    <section
      id="book"
      className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm"
    >
      <div className="mb-2 text-[12px] font-bold uppercase tracking-wider text-gray-500">
        Book a call
      </div>
      <h3 className="mb-2 text-[18px] font-bold">Let us know how we can help</h3>
      <p className="mb-6 text-[14px] leading-relaxed text-gray-600">
        You'll answer a few questions on the booking page.
      </p>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!href) return;
          window.open(href, "_blank", "noopener,noreferrer");
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[13px] font-semibold text-gray-700">
              Company email
            </label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jeff@amazon.com"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[14px] text-gray-900 outline-none transition focus:border-gray-300"
              autoComplete="email"
              type="email"
            />
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-semibold text-gray-700">
              Company
            </label>
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Amazon"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[14px] text-gray-900 outline-none transition focus:border-gray-300"
              autoComplete="organization"
            />
          </div>
        </div>

        <div className="rounded-xl border border-gray-100 bg-gray-50 p-5 text-[13px] text-gray-600">
          You'll fill the rest on the booking page.
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {props.calUrl ? (
            <button type="submit" className="doc-button">
              Continue to booking
            </button>
          ) : (
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-500">
              Cal link not set yet.
            </div>
          )}
          {props.calUrl ? (
            <a
              href={props.calUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] text-gray-400 transition hover:text-black"
            >
              Open booking link
            </a>
          ) : null}
        </div>
      </form>
    </section>
  );
}
