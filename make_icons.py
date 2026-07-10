"""Genere les icones PNG de la PWA Boussole (192, 512, maskable 512, favicon 64).

Icone : une boussole stylisee (cercle + aiguille) sur fond degrade indigo -> bleu nuit.
Aucune dependance en ligne, tout est dessine avec Pillow.
"""
import math
from PIL import Image, ImageDraw

BG_TOP = (99, 102, 241)      # indigo-500
BG_BOT = (11, 18, 32)        # bleu nuit
FG = (255, 255, 255)
NEEDLE = (248, 113, 113)     # rouge (pointe nord)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG_TOP)
    top, bot = BG_TOP, BG_BOT
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        for x in range(size):
            img.putpixel((x, y), (r, g, b))
    return img


def draw_compass(img: Image.Image, inset_ratio: float) -> None:
    d = ImageDraw.Draw(img)
    s = img.size[0]
    m = int(s * inset_ratio)
    line = max(2, int(s * 0.045))
    box = [m, m, s - m, s - m]
    cx, cy = s // 2, s // 2
    r = (s - 2 * m) // 2
    # cercle exterieur
    d.ellipse(box, outline=FG, width=line)
    # aiguille (losange) nord-sud, legerement penchee
    ang = math.radians(-35)
    nx, ny = math.sin(ang), -math.cos(ang)
    tip = int(r * 0.72)
    wid = int(r * 0.22)
    px, py = -ny, nx  # perpendiculaire
    north = (cx + nx * tip, cy + ny * tip)
    south = (cx - nx * tip, cy - ny * tip)
    left = (cx + px * wid, cy + py * wid)
    right = (cx - px * wid, cy - py * wid)
    d.polygon([north, left, south, right], outline=FG, width=max(2, int(line * 0.6)))
    d.polygon([north, left, (cx, cy), right], fill=NEEDLE)  # moitie nord rouge
    # point central
    cr = max(3, int(s * 0.03))
    d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=FG)


def build(size: int, maskable: bool, path: str) -> None:
    img = gradient(size)
    inset = 0.26 if maskable else 0.16
    draw_compass(img, inset)
    img.save(path)
    print("ecrit", path)


if __name__ == "__main__":
    import os
    os.makedirs("icons", exist_ok=True)
    build(192, False, "icons/icon-192.png")
    build(512, False, "icons/icon-512.png")
    build(512, True, "icons/icon-maskable-512.png")
    build(64, False, "icons/favicon-64.png")
