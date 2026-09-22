import { useState } from "react";
import boggarts from "@/assets/daylight/berner-boggarts.png";
import thunderbirds from "@/assets/daylight/turicum-thunderbirds.png";

// Exact verified identities only; tournament uploads are not global team identifiers.
const artwork: Readonly<Record<string, string>> = {
  "Berner Boggarts": boggarts,
  "Berner Boggarts QC": boggarts,
  "Turicum Thunderbirds": thunderbirds,
};
export function PublicTeamArtwork({ name }: { name: string | null }) {
  const source = name === null ? undefined : artwork[name];
  const [failedSource, setFailedSource] = useState<string>();
  const initials = (name ?? "Unassigned Team")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return source !== undefined && failedSource !== source ? (
    <img
      className="daylight-team-art"
      src={source}
      alt=""
      onError={() => setFailedSource(source)}
    />
  ) : (
    <span className="daylight-team-art daylight-initials" aria-hidden="true">
      {initials}
    </span>
  );
}
