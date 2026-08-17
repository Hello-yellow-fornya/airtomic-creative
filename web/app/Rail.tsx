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
  { idx: "02", label: "Find", match: (p) => p.startsWith("/videos/") },
  { idx: "03", label: "Suggested cuts", href: "/cuts", match: (p) => p === "/cuts" },
  {
    idx: "04",
    label: "Clip builder",
    href: "/clips",
    match: (p) =>
      p === "/clips" || (p.startsWith("/variants/") && !p.endsWith("/preview")),
  },
  {
    idx: "05",
    label: "Preview",
    match: (p) => p.startsWith("/variants/") && p.endsWith("/preview"),
  },
  { idx: "06", label: "Review queue", href: "/queue", match: (p) => p === "/queue" },
  { idx: "07", label: "Send to Meta", href: "/send", match: (p) => p === "/send" },
];

const SETUP: typeof STEPS = [
  { idx: "—", label: "Brand assets", href: "/assets", match: (p) => p === "/assets" },
  { idx: "—", label: "Subtitle styles", href: "/styles", match: (p) => p === "/styles" },
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
        {STEPS.map((s) => (
          <RailItem key={s.label} step={s} path={path} />
        ))}
        <div className="nav-label">Setup</div>
        {SETUP.map((s) => (
          <RailItem key={s.label} step={s} path={path} />
        ))}
      </nav>
      <div className="rail-foot">
        <p>Ads land paused. Nothing publishes without review.</p>
      </div>
    </aside>
  );
}

function RailItem({
  step,
  path,
}: {
  step: (typeof STEPS)[number];
  path: string;
}) {
  const current = step.match(path);
  if (step.href) {
    return (
      <Link href={step.href} className="nav-item" aria-current={current || undefined}>
        <span className="idx">{step.idx}</span>
        {step.label}
      </Link>
    );
  }
  return (
    <span className="nav-item" aria-current={current || undefined}
      data-off={current ? undefined : "1"}>
      <span className="idx">{step.idx}</span>
      {step.label}
    </span>
  );
}
