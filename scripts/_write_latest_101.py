from pathlib import Path
import json
from datetime import datetime, timezone
sig = Path("release-out/Z-Animes_6.0.101_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Nouveau\n"
    "- Notes de version in-app : timeline cards (CHANGELOG, point rouge, badges DERNIÈRE / INSTALLÉE)\n"
    "\n"
    "## Amélioré\n"
    "- Fond cyberpunk hero derrière les notes\n"
    "- Lignes Nouveau / Amélioré / Corrigé avec icônes compactes dans les cards"
)
payload = {
    "version": "6.0.101",
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": "https://github.com/Apnkk/z-flix-anime/releases/download/v6.0.101/Z-Animes_6.0.101_x64-setup.exe",
        }
    },
}
text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
for name in ("latest.json", "release-out/latest.json", "release-out/latest-6.0.101.json"):
    Path(name).write_bytes(text.encode("utf-8"))
raw = Path("release-out/latest.json").read_bytes()
assert not raw.startswith(b"\xef\xbb\xbf")
assert "Amélioré".encode("utf-8") in raw
print("latest ok", len(raw))
