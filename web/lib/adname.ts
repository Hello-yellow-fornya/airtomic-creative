/** Ad naming per convention: KLR_{SOURCE}_{topic}_{LABEL}.
 * The topic comes from the VARIANT name — since 0015 the variant is the
 * named unit and the parent clip carries no name. Shared by the Send
 * screen and export downloads so a downloaded file carries the exact name
 * the ad would, and stays parse-friendly for the ad_creative name parser
 * when a variant is pushed to Meta. */

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

export function adName(v: {
  videoSource: string; name: string; label: string;
}): string {
  const src = v.videoSource === "longform" ? "POD" : "AD";
  const topic = slugify(v.name).replace(/-/g, "_") || "clip";
  return `KLR_${src}_${topic}_${v.label}`;
}

/** Filename for one export file: ad name + ratio + extension. */
export function exportFilename(
  v: { videoSource: string; name: string; label: string },
  ratio: string,
  ext: "mp4" | "srt",
): string {
  return `${adName(v)}_${ratio.replace(/\./g, "_")}.${ext}`;
}
