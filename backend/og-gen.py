"""Generate 1200x630 OG card PNGs for /camel/ and /cabal/."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = "/tmp/og"
os.makedirs(OUT, exist_ok=True)

def font(size, bold=False):
    paths = [
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Courier New Bold.ttf" if bold else "/System/Library/Fonts/Courier New.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: continue
    return ImageFont.load_default()

def hatched(img, color=(8,18,8,255), step=12):
    d = ImageDraw.Draw(img)
    w, h = img.size
    for i in range(-h, w, step*2):
        d.line([(i, 0), (i+h, h)], fill=color, width=step)

def cabal_card():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (10, 26, 10))
    hatched(img)
    d = ImageDraw.Draw(img)
    # green border
    d.rectangle([(8,8),(W-9,H-9)], outline=(76,212,76), width=4)
    # title
    d.text((60, 110), "/cabal/", fill=(76,212,76), font=font(180, bold=True))
    d.text((60, 320), "camels only", fill=(255,255,255), font=font(72, bold=True))
    d.text((60, 410), "no algorithm  ·  no normies  ·  no fed posting", fill=(155,208,155), font=font(34))
    d.text((60, 470), "hold ≥ 1 CAMEL NFT  ·  sign once  ·  enter the tent", fill=(111,168,111), font=font(28))
    d.text((60, 550), "<your-domain>/cabal", fill=(76,212,76), font=font(28, bold=True))
    # corner glyph
    d.text((W-180, 80), "▣", fill=(76,212,76), font=font(140, bold=True))
    img.save(f"{OUT}/cabal.png", "PNG", optimize=True)
    print("wrote cabal.png", os.path.getsize(f"{OUT}/cabal.png"))

def camel_card():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), (15, 15, 15))
    d = ImageDraw.Draw(img)
    # green band header
    d.rectangle([(0,0),(W,180)], fill=(0,122,51))
    d.text((60, 30), "CAMEL CABAL", fill=(255,255,255), font=font(96, bold=True))
    d.text((60, 130), "TERMINAL", fill=(255,255,255), font=font(40, bold=True))
    # body
    d.text((60, 230), "$CAMEL — DN404 scarcity tracker", fill=(76,212,76), font=font(46, bold=True))
    d.text((60, 300), "live mints  ·  burns  ·  market stats  ·  defined chart", fill=(180,220,180), font=font(30))
    d.text((60, 360), "buy $CAMEL  ·  the cabal  ·  links", fill=(180,220,180), font=font(30))
    # contract
    d.text((60, 480), "Contract  0x000Caba1002917B27300d7b67Be2d1C51B93bF00", fill=(120,180,120), font=font(22))
    d.text((60, 540), "<your-domain>/camel", fill=(76,212,76), font=font(28, bold=True))
    # right-side dot pattern
    for x in range(0, 200, 12):
        for y in range(0, H, 12):
            d.ellipse([(W-200+x, y), (W-200+x+3, y+3)], fill=(0,80,30))
    img.save(f"{OUT}/camel.png", "PNG", optimize=True)
    print("wrote camel.png", os.path.getsize(f"{OUT}/camel.png"))

cabal_card()
camel_card()
