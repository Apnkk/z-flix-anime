"""Crop One Piece anime sheets into 160x160 avatars, overwrite live-action pack."""
from __future__ import annotations

from pathlib import Path
from PIL import Image

ASSETS = Path(r"C:\Users\Ares\.cursor\projects\p-SITE-STREAMING-v14-zflix-launcher\assets")
OUT = Path(r"P:\SITE STREAMING\v14\z-animes\public\avatars\One Piece")
SIZE = 160
CATEGORY = "One Piece"

SHEETS = [
    ("sheet-onepiece-anime-2.png", 3, 2, 6, 0.0),
    ("sheet-onepiece-anime-b.png", 3, 2, 6, 0.0),
    ("sheet-onepiece-anime-c.png", 2, 2, 4, 0.0),
]


def crop_grid(im: Image.Image, cols: int, rows: int, count: int, trim_bottom: float) -> list[Image.Image]:
    w, h = im.size
    tw, th = w // cols, h // rows
    out: list[Image.Image] = []
    n = 0
    for r in range(rows):
        for c in range(cols):
            if n >= count:
                break
            cell = im.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th))
            if trim_bottom > 0:
                cw, ch = cell.size
                cell = cell.crop((0, 0, cw, int(ch * (1.0 - trim_bottom))))
            cw, ch = cell.size
            side = min(cw, ch)
            x0 = (cw - side) // 2
            y0 = max(0, (ch - side) // 3)
            square = cell.crop((x0, y0, x0 + side, y0 + side))
            out.append(square.resize((SIZE, SIZE), Image.Resampling.LANCZOS).convert("RGB"))
            n += 1
        if n >= count:
            break
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # wipe old live-action
    for old in OUT.glob("*.png"):
        old.unlink()
    idx = 1
    for name, cols, rows, count, trim in SHEETS:
        path = ASSETS / name
        if not path.exists():
            print("MISSING", name)
            continue
        tiles = crop_grid(Image.open(path).convert("RGB"), cols, rows, count, trim)
        for tile in tiles:
            if idx > 14:
                break
            out = OUT / f"Avatar {CATEGORY} {idx}.png"
            tile.save(out, "PNG", optimize=True)
            print("wrote", out.name)
            idx += 1
    print("total", idx - 1)


if __name__ == "__main__":
    main()
