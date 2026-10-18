"""Build the TalonHive mark from the approved reference image (brand/reference-mark.jpg).

1. Crop the mark (the "CLAW HIVE" text below it is ignored), threshold to pure black/white.
2. Trace the outline with sub-pixel precision (scikit-image), lightly smooth the pixel steps.
3. Write brand/talonhive-mark.svg (one even-odd path) and render every size from that vector.

    python brand/build_mark.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage import measure

HERE = Path(__file__).parent
REF = HERE / "reference-mark.jpg"
SVG = HERE / "talonhive-mark.svg"
OUT = HERE / "out"
TEXT_TOP = 950          # everything below this row is the "CLAW HIVE" lettering
UPSCALE = 4             # trace on a 4x upscaled, blurred copy for smooth sub-pixel edges
SMOOTH = 2              # moving-average window (in traced points) to remove stair-steps
TOLERANCE = 0.35        # polygon simplification tolerance (reference pixels)


def trace():
    g = Image.open(REF).convert("L")
    w, h = g.size
    g = g.crop((0, 0, w, TEXT_TOP))
    big = g.resize((g.width * UPSCALE, g.height * UPSCALE), Image.LANCZOS).filter(ImageFilter.GaussianBlur(UPSCALE * 0.6))
    ink = 1.0 - np.asarray(big, dtype=float) / 255.0          # 1 = black mark
    ink = np.pad(ink, 2)                                        # close contours at the border
    contours = measure.find_contours(ink, 0.5)
    paths = []
    for c in contours:
        if len(c) < 30:                                         # drop specks/noise
            continue
        pts = c[:, ::-1] / UPSCALE - 2 / UPSCALE                # (row,col) -> (x,y), undo pad + upscale
        if SMOOTH > 1:                                          # circular moving average
            k = SMOOTH * 2 + 1
            ext = np.vstack([pts[-SMOOTH:], pts, pts[:SMOOTH]])
            pts = np.vstack([np.convolve(ext[:, i], np.ones(k) / k, mode="valid") for i in (0, 1)]).T
        pts = measure.approximate_polygon(pts, TOLERANCE)
        paths.append(pts)
    return paths


def bbox(paths):
    allp = np.vstack(paths)
    return allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max()


def write_svg(paths):
    x0, y0, x1, y1 = bbox(paths)
    side = max(x1 - x0, y1 - y0) * 1.08                        # small even margin, square icon
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    vb = (cx - side / 2, cy - side / 2, side, side)
    d = " ".join("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in p) + " Z" for p in paths)
    SVG.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.1f} {vb[1]:.1f} {vb[2]:.1f} {vb[3]:.1f}">\n'
        f'  <title>TalonHive mark</title>\n'
        f'  <!-- Traced from brand/reference-mark.jpg by brand/build_mark.py -->\n'
        f'  <path fill="#000" fill-rule="evenodd" d="{d}"/>\n</svg>\n', encoding="utf-8")
    return vb


def render(paths, vb, size, invert=False, background="#ffffff", ss=4):
    S = size * ss
    k = S / vb[2]
    mask = np.zeros((S, S), dtype=bool)
    for p in paths:                                             # even-odd fill: XOR every ring
        m = Image.new("1", (S, S), 0)
        ImageDraw.Draw(m).polygon([((x - vb[0]) * k, (y - vb[1]) * k) for x, y in p], fill=1)
        mask ^= np.asarray(m, dtype=bool)
    fg, bg = ((255, 255, 255), (0, 0, 0)) if invert else ((0, 0, 0), tuple(int(background[i:i + 2], 16) for i in (1, 3, 5)))
    img = Image.new("RGB", (S, S), bg)
    img.paste(Image.new("RGB", (S, S), fg), (0, 0), Image.fromarray((mask * 255).astype("uint8")))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    paths = trace()
    vb = write_svg(paths)
    print(f"traced {len(paths)} outlines, {sum(len(p) for p in paths)} points -> {SVG.name}")
    OUT.mkdir(exist_ok=True)
    for name, size, inv in [("talonhive-mark-512.webp", 512, False), ("talonhive-mark-512-dark.webp", 512, True),
                            ("talonhive-mark-512.png", 512, False), ("talonhive-mark-180.png", 180, False),
                            ("talonhive-mark-32.png", 32, False)]:
        im = render(paths, vb, size, invert=inv)
        path = OUT / name
        im.save(path, "WEBP", quality=95, method=6) if name.endswith(".webp") else im.save(path)
        print("wrote", path.relative_to(HERE.parent))
