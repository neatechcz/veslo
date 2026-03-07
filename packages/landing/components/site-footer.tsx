import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-12 flex flex-col items-center justify-between gap-6 border-t border-gray-100 pb-12 pt-24 text-[14px] text-gray-600 md:flex-row">
      <div className="flex gap-6">
        <Link href="#" className="transition hover:text-black">
          Safety guide
        </Link>
        <Link href="#" className="transition hover:text-black">
          Terms
        </Link>
        <Link href="#" className="transition hover:text-black">
          Privacy
        </Link>
      </div>
      <span>© 2026 Veslo Project.</span>
    </footer>
  );
}
