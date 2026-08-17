import { q } from "@/lib/db";
import { Topbar } from "../ui";
import StyleList from "./StyleList";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const presets = await q<{
    id: string; name: string; is_default: boolean;
    config: Record<string, unknown>; updated_at: string;
  }>(
    "SELECT id::text, name, is_default, config, updated_at::text FROM subtitle_presets ORDER BY is_default DESC, created_at",
  );

  return (
    <>
      <Topbar title="Subtitle styles" sub="Presets shared across every clip" />
      <section className="screen">
        <div className="stack" style={{ maxWidth: 760 }}>
          <div className="note">
            Previews here render with the same settings the export uses —
            edits apply to every clip on that preset from its next render.
          </div>
          <StyleList
            presets={presets.map((p) => ({
              id: p.id, name: p.name, isDefault: p.is_default,
              config: {
                fs: Number(p.config.fs ?? 30), ol: Number(p.config.ol ?? 3),
                vp: Number(p.config.vp ?? 72), wpl: Number(p.config.wpl ?? 4),
                hl: String(p.config.hl ?? "#FFC629"),
                caps: !!p.config.caps, box: !!p.config.box,
                font: String(p.config.font ?? "Inter"),
              },
            }))}
          />
          <div className="card pad">
            <div className="eyebrow" style={{ marginBottom: 9 }}>
              Fonts available to the renderer
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              <span className="tag">Inter</span>
              <span className="tag">DejaVu Sans</span>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 9 }}>
              Fonts are installed in the render worker&apos;s image
              (worker/Dockerfile). Adding one there makes it available to both
              the preview and the export.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
