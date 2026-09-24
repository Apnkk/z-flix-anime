from pathlib import Path
import json
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
VER = "6.0.106"
sig = (ROOT / f"release-out/Z-Animes_{VER}_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Amélioré\n"
    "- Détection épisodes diffusés : logique saison-aware (dates TMDB)\n"
    "- Fiche + player : épisodes futurs grisés « À venir » avec date\n"
    "\n"
    "## Corrigé\n"
    "- Inférence épisode sorti sans air_date quand saison a dates connues"
)
payload = {
    "version": VER,
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": f"https://github.com/Apnkk/z-flix-anime/releases/download/v{VER}/Z-Animes_{VER}_x64-setup.exe",
        }
    },
}
out = ROOT / "release-out/latest.json"
out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print("wrote", out)
