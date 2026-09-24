from pathlib import Path
import json
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sig = (ROOT / "release-out/Z-Animes_6.0.103_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Nouveau\n"
    "- Protection sources : flux via tickets opaques (embed-gate / admin-proxy) au lieu d'URLs brutes dans le réseau\n"
    "\n"
    "## Amélioré\n"
    "- Client desktop atteste le Worker (X-Zflix-Client) pour accès embed-gate\n"
    "- Moins de fuite sibnet/sendvid/vidmoly dans les réponses API\n"
    "\n"
    "## Corrigé\n"
    "- Compat Worker resolve-shield (6.0.102 player fixes inclus)"
)
payload = {
    "version": "6.0.103",
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": "https://github.com/Apnkk/z-flix-anime/releases/download/v6.0.103/Z-Animes_6.0.103_x64-setup.exe",
        }
    },
}
text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
for name in ("latest.json", "release-out/latest.json", "release-out/latest-6.0.103.json"):
    p = ROOT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode("utf-8"))
raw = (ROOT / "release-out/latest.json").read_bytes()
assert not raw.startswith(b"\xef\xbb\xbf")
print("latest ok", len(raw))
