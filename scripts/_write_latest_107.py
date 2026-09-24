from pathlib import Path
import json
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
VER = "6.0.107"
sig = (ROOT / f"release-out/Z-Animes_{VER}_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Corrigé\n"
    "- One Piece / longues séries : flux Zulu (/zcdn-hls) ignoré car URL relative → 18 serveurs KO\n"
    "- Extraction embeds VoirAnime : budget adapté + embed-gate pris en compte\n"
    "- Tickets admin-proxy morts : fallback décode + extract au lieu de fail direct\n"
    "- Zulu (catalogue HLS) priorisé en wave 0 anime\n"
    "\n"
    "## Amélioré\n"
    "- Timeout scrapers anime (VoirAnime, Franime…) augmenté"
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
