from pathlib import Path
import json
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sig = (ROOT / "release-out/Z-Animes_6.0.104_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Amélioré\n"
    "- Affichage images : fallback TMDB posters/backdrops quand poster_path manquant\n"
    "- Épisodes sans still → poster série\n"
    "\n"
    "## Corrigé\n"
    "- Séries animés obscurs sans vignette catalogue\n"
    "- Compat desktop-core images (6.0.103 protections incluses)"
)
payload = {
    "version": "6.0.104",
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": "https://github.com/Apnkk/z-flix-anime/releases/download/v6.0.104/Z-Animes_6.0.104_x64-setup.exe",
        }
    },
}
text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
for name in ("latest.json", "release-out/latest.json", "release-out/latest-6.0.104.json"):
    p = ROOT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode("utf-8"))
raw = (ROOT / "release-out/latest.json").read_bytes()
assert not raw.startswith(b"\xef\xbb\xbf")
print("latest ok", len(raw))
