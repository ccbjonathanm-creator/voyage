"""Icones de la mini-appli Generateur : cle 3D glossy sur degrade neon violet -> cyan."""
from PIL import Image, ImageDraw, ImageFilter

C1 = (139, 123, 255); C2 = (34, 211, 238); SRC = "icons/_src_key.png"


def gradient(S):
    img = Image.new("RGB", (S, S)); px = img.load(); den = 2*(S-1)
    for y in range(S):
        for x in range(S):
            t = (x+y)/den
            px[x, y] = (int(C1[0]+(C2[0]-C1[0])*t), int(C1[1]+(C2[1]-C1[1])*t), int(C1[2]+(C2[2]-C1[2])*t))
    return img.convert("RGBA")


def gloss(S):
    lay = Image.new("L", (S, S), 0); px = lay.load(); cx, cy, rad = S*0.28, S*0.20, S*0.75
    for y in range(S):
        for x in range(S):
            d = (((x-cx)**2+(y-cy)**2)**0.5)/rad; v = max(0.0, 1.0-d); px[x, y] = int(60*v*v)
    return lay


def rounded(S, r):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S-1, S-1], radius=int(S*r), fill=255)
    return m


def build(size, maskable, path):
    SS = size*3
    base = gradient(SS)
    base = Image.composite(Image.new("RGBA", (SS, SS), (255, 255, 255, 255)), base, gloss(SS)).convert("RGBA")
    obj = Image.open(SRC).convert("RGBA")
    scale = 0.52 if maskable else 0.62
    t = int(SS*scale); obj = obj.resize((t, t), Image.LANCZOS); pos = ((SS-t)//2, (SS-t)//2)
    sh = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    dark = Image.composite(Image.new("RGBA", obj.size, (10, 15, 40, 150)), Image.new("RGBA", obj.size, (0, 0, 0, 0)), obj.getchannel("A"))
    sh.alpha_composite(dark, (pos[0], pos[1]+int(SS*0.03))); sh = sh.filter(ImageFilter.GaussianBlur(SS*0.025))
    base.alpha_composite(sh); base.alpha_composite(obj, pos)
    if not maskable:
        base.putalpha(rounded(SS, 0.22))
    base.resize((size, size), Image.LANCZOS).save(path); print("ecrit", path)


if __name__ == "__main__":
    build(192, False, "icons/icon-192.png")
    build(512, False, "icons/icon-512.png")
    build(512, True, "icons/icon-maskable-512.png")
    build(64, False, "icons/favicon-64.png")
