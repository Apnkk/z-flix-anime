from pathlib import Path
import json
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
VER = "6.0.108"
sig = (ROOT / f"release-out/Z-Animes_{VER}_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Corrigé\n"
    "- One Piece S16E660 : VoirAnime renvoie maintenant flux MP4 direct (plus 18 serveurs KO)\n"
    "- Worker : route /zcdn-hls manquante + CDN mort filtré (Zulu)\n"
    "- Worker : flux voe/voembed ASN renvoyés au desktop (plus admin-proxy 502)\n"
    "- Race sources 16s + VoirAnime/Zulu en wave 0\n"
    "\n"
    "## Amélioré\n"
    "- Token auth sur resolve (rate-limit guest)"
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
