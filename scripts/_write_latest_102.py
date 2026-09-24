from pathlib import Path
import json
from datetime import datetime, timezone

sig = Path("release-out/Z-Animes_6.0.102_x64-setup.exe.sig").read_text(encoding="utf-8").strip()
notes = (
    "## Corrigé\n"
    "- Changement d'épisode rapide : annulation des resolves en cours, debounce 220 ms, HLS détruit proprement\n"
    "- Plus de courses fantômes qui rejouaient un ancien flux ou empilaient les probes\n"
    "\n"
    "## Amélioré\n"
    "- Serveur mémorisé (sticky) : 1 seul resolve puis lecture, le reste en arrière-plan\n"
    "- Prefetch épisode suivant annulé au switch pour libérer le réseau"
)
payload = {
    "version": "6.0.102",
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": "https://github.com/Apnkk/z-flix-anime/releases/download/v6.0.102/Z-Animes_6.0.102_x64-setup.exe",
        }
    },
}
text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
for name in ("latest.json", "release-out/latest.json", "release-out/latest-6.0.102.json"):
    Path(name).write_bytes(text.encode("utf-8"))
raw = Path("release-out/latest.json").read_bytes()
assert not raw.startswith(b"\xef\xbb\xbf")
print("latest ok", len(raw))
