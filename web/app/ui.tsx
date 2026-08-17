import type { ReactNode } from "react";

/** Sticky page header, prototype `.topbar` treatment. Pass buttons/links as
 * children to render them right-aligned. */
export function Topbar({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row">{children}</div>}
    </header>
  );
}
