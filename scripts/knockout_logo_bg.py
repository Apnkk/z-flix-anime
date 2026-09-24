from collections import deque
from pathlib import Path

from PIL import Image

PATHS = [
    Path(r"P:\SITE STREAMING\v14\z-animes\public\icon.png"),
    Path(r"P:\SITE STREAMING\v14\z-animes\src-tauri\icons\icon.png"),
]


def knockout(src: Path) -> None:
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_bg(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        if a == 0:
            return True
        return r <= 40 and g <= 40 and b <= 40 and (max(r, g, b) - min(r, g, b)) <= 18

    seen = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y):
                q.append((x, y))
                seen[y][x] = True
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y][x] and is_bg(x, y):
                q.append((x, y))
                seen[y][x] = True

    cleared = 0
    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        cleared += 1
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and is_bg(nx, ny):
                seen[ny][nx] = True
                q.append((nx, ny))

    img.save(src, "PNG")
    print(f"{src.name}: cleared {cleared} px")


def main() -> None:
    for src in PATHS:
        if src.exists():
            knockout(src)
        else:
            print(f"skip {src}")


if __name__ == "__main__":
    main()
