"""Crop contact-sheet PNGs into 160x160 Netflix-style avatars."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ASSETS = Path(r"C:\Users\Ares\.cursor\projects\p-SITE-STREAMING-v14-zflix-launcher\assets")
OUT_ROOT = Path(r"P:\SITE STREAMING\v14\z-animes\public\avatars")
SIZE = 160

# sheet file -> (category folder, cols, rows, count, trim_bottom_pct for label bars)
SHEETS: list[tuple[str, str, int, int, int, float]] = [
    ("sheet-naruto.png", "Naruto", 4, 2, 8, 0.0),
    ("sheet-demonslayer.png", "Demon Slayer", 4, 2, 8, 0.0),
    ("sheet-aot.png", "Attack on Titan", 4, 2, 8, 0.0),
    ("sheet-jjk.png", "Jujutsu Kaisen", 4, 2, 8, 0.0),
    ("sheet-hxh.png", "Hunter x Hunter", 4, 2, 8, 0.18),
    ("sheet-spy.png", "Spy x Family", 4, 2, 8, 0.18),
    ("sheet-frieren.png", "Frieren", 4, 2, 8, 0.0),
    ("sheet-chainsaw.png", "Chainsaw Man", 4, 2, 8, 0.0),
    ("sheet-classiques.png", "Classiques", 4, 2, 8, 0.18),
    ("sheet-classiques-extra.png", "Classiques", 2, 2, 2, 0.0),  # append as 9-10
]


def crop_grid(
    im: Image.Image,
    cols: int,
    rows: int,
    count: int,
    trim_bottom: float,
) -> list[Image.Image]:
    w, h = im.size
    tw, th = w // cols, h // rows
    out: list[Image.Image] = []
    n = 0
    for r in range(rows):
        for c in range(cols):
            if n >= count:
                break
            left, top = c * tw, r * th
            cell = im.crop((left, top, left + tw, top + th))
            if trim_bottom > 0:
                cw, ch = cell.size
                cell = cell.crop((0, 0, cw, int(ch * (1.0 - trim_bottom))))
            # center-crop square then resize
            cw, ch = cell.size
            side = min(cw, ch)
            x0 = (cw - side) // 2
            y0 = max(0, (ch - side) // 3)  # bias upward toward face
            square = cell.crop((x0, y0, x0 + side, y0 + side))
            out.append(square.resize((SIZE, SIZE), Image.Resampling.LANCZOS).convert("RGB"))
            n += 1
        if n >= count:
            break
    return out


def main() -> None:
    for p in sorted(ASSETS.glob("sheet-*.png")):
        im = Image.open(p)
        print(f"{p.name}: {im.size} {im.mode}")

    # wipe non-anime category folders later; here only write packs
    start_index: dict[str, int] = {}
    for sheet_name, category, cols, rows, count, trim in SHEETS:
        path = ASSETS / sheet_name
        if not path.exists():
            print(f"MISSING {sheet_name}")
            continue
        im = Image.open(path).convert("RGB")
        tiles = crop_grid(im, cols, rows, count, trim)
        dest = OUT_ROOT / category
        dest.mkdir(parents=True, exist_ok=True)
        base = start_index.get(category, 0)
        for i, tile in enumerate(tiles, start=1):
            idx = base + i
            out = dest / f"Avatar {category} {idx}.png"
            tile.save(out, "PNG", optimize=True)
            print(f"  wrote {out.name} ({tile.size})")
        start_index[category] = base + len(tiles)
        print(f"{category}: {start_index[category]} avatars")


if __name__ == "__main__":
    main()
