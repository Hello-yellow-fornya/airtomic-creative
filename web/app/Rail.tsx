"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/* Workflow steps mirror docs/prototype.html. Steps without a built route
   yet render dimmed and unclickable — the numbering is the product map. */
const STEPS: {
  idx: string;
  label: string;
  href?: string;
  match: (path: string) => boolean;
}[] = [
  { idx: "01", label: "Library", href: "/", match: (p) => p === "/" },
  { idx: "02", label: "Transcript", match: (p) => p.startsWith("/videos/") },
  { idx: "03", label: "Suggested cuts", href: "/cuts", match: (p) => p === "/cuts" },
  {
    idx: "04",
    label: "Clip builder",
    href: "/clips",
    match: (p) => p === "/clips" || p.startsWith("/variants/"),
  },
  { idx: "05", label: "Preview", match: () => false },
  { idx: "06", label: "Review queue", match: () => false },
  { idx: "07", label: "Send to Meta", match: () => false },
];

export default function Rail() {
  const path = usePathname();

  return (
    <aside className="rail">
      <Link href="/" className="brand">
        <span className="brand-mark">
          <span className="dot" />
          Creative Builder
        </span>
        <span className="brand-sub">Klira · Hello Yellow</span>
      </Link>
      <nav className="nav">
        <div className="nav-label">Workflow</div>
        {STEPS.map((s) => {
          const current = s.match(path);
          if (s.href) {
            return (
              <Link
                key={s.idx}
                href={s.href}
                className="nav-item"
                aria-current={current || undefined}
              >
                <span className="idx">{s.idx}</span>
                {s.label}
              </Link>
            );
          }
          return (
            <span
              key={s.idx}
              className="nav-item"
              aria-current={current || undefined}
              data-off={current ? undefined : "1"}
            >
              <span className="idx">{s.idx}</span>
              {s.label}
            </span>
          );
        })}
      </nav>
      <div className="rail-foot">
        <p>Ads land paused. Nothing publishes without review.</p>
      </div>
    </aside>
  );
}
