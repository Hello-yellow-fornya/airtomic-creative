"use client";

import { useRouter } from "next/navigation";

export default function RenameButton({
  videoId, current,
}: {
  videoId: string; current: string | null;
}) {
  const router = useRouter();
  return (
    <button className="btn ghost sm"
      onClick={async () => {
        const name = window.prompt("Video title", current ?? "");
        if (name === null || name.trim() === (current ?? "")) return;
        await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: name.trim() || null }),
        });
        router.refresh();
      }}>
      Rename
    </button>
  );
}
