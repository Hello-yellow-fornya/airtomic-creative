/** Ad naming per convention: KLR_{SOURCE}_{topic}_c{NN}_{LABEL}_{slug}.
 * Topic and cut number come from the clip name until the recommendation
 * engine supplies them. Shared by the Send screen and export downloads so
 * a downloaded file carries the exact name the ad would. */

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

export function adName(v: {
  videoSource: string; clipName: string | null; label: string; slug: string;
}): string {
  const src = v.videoSource === "longform" ? "POD" : "AD";
  const topic = slugify(v.clipName ?? "clip").replace(/-/g, "_") || "clip";
  return `KLR_${src}_${topic}_${v.label}_${v.slug}`;
}

/** Filename for one export file: ad name + ratio + extension. */
export function exportFilename(
  v: { videoSource: string; clipName: string | null; label: string; slug: string },
  ratio: string,
  ext: "mp4" | "srt",
): string {
  return `${adName(v)}_${ratio.replace(/\./g, "_")}.${ext}`;
}
