from pathlib import Path
OLD, NEW = "6.0.100", "6.0.101"
for path, a, b in [
    (Path("package.json"), f'"version": "{OLD}"', f'"version": "{NEW}"'),
    (Path("src-tauri/tauri.conf.json"), f'"version": "{OLD}"', f'"version": "{NEW}"'),
    (Path("src-tauri/Cargo.toml"), f'version = "{OLD}"', f'version = "{NEW}"'),
]:
    text = path.read_text(encoding="utf-8")
    if a not in text:
        raise SystemExit(f"missing {a!r} in {path}")
    path.write_text(text.replace(a, b, 1), encoding="utf-8")
    print("ok", path)
