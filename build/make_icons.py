"""Generate NovaCode icons: a purple, outline-only four-pointed star."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent
S = 4096  # supersample canvas
PURPLE = (168, 85, 247, 255)
BG = (15, 11, 26, 255)


def star_points(cx, cy, r, p=0.62, n=720):
    """Concave four-pointed star via superellipse |x|^p + |y|^p = 1 (p<1)."""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        x = math.copysign(abs(c) ** (2 / p), c)
        y = math.copysign(abs(s) ** (2 / p), s)
        pts.append((cx + r * x, cy - r * y))
    return pts


def render(size=1024, rounded=True):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=BG)
    # outline = filled outer star minus a scaled inner star (clean sharp tips)
    d.polygon(star_points(S / 2, S / 2, S * 0.38), fill=PURPLE)
    d.polygon(star_points(S / 2, S / 2, S * 0.38 * 0.80, p=0.60), fill=BG if rounded else (0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


def main():
    render(1024).save(OUT / "icon.png")
    render(512, rounded=False).save(OUT / "tray.png")
    base = render(1024)
    base.save(OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    base.save(OUT / "icon.icns")
    # renderer favicon / logo
    pub = OUT.parent / "src" / "renderer" / "public"
    pub.mkdir(parents=True, exist_ok=True)
    render(256, rounded=False).save(pub / "logo.png")
    render(64).save(pub / "favicon.png")
    print("icons ok")


if __name__ == "__main__":
    main()
