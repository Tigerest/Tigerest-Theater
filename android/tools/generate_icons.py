"""Generate the Android launcher icon from the black/gold Tigerest artwork.

The source is the 1024 px tile in bundle/tigerest-icon-1024.png, as for the
iPhone / iPad and Apple TV icons. The gold mark is lifted off its dark tile into the adaptive icon's
foreground and monochrome layers; the background is the tile's own colour.
Requires Pillow. Run from the repository root:
    python android/tools/generate_icons.py
"""
import pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'bundle/tigerest-icon-1024.png'
RES = ROOT / 'android/app/src/main/res'
TILE = (23, 23, 23)
# The mark is 48 dp wide on the 108 dp layer, so its corners stay inside the
# 66 dp safe circle that every launcher mask keeps.
MARK_DP, LAYER_DP = 48, 108
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}

def lifted(tile):
    """The mark on transparency: each pixel's coverage over the tile colour, unblended."""
    mark = Image.new('RGBA', tile.size)
    out, pixels = mark.load(), tile.load()
    for y in range(tile.height):
        for x in range(tile.width):
            colour = pixels[x, y]
            alpha = min(1.0, max(0.0, (max(colour) - max(TILE)) / (242 - max(TILE))))
            if alpha > .03:  # the tile's own grain is a few levels either way
                out[x, y] = (*(round(min(255, max(0, t + (c - t) / alpha))) for c, t in zip(colour, TILE)), round(alpha * 255))
    return mark.crop(mark.getbbox())

def main():
    tile = Image.open(SOURCE)
    # Outside its rounded corners the artwork is transparent white, and the
    # tile's rim is lighter than its face: lift only around the gold and white mark.
    tile = Image.alpha_composite(Image.new('RGBA', tile.size, (*TILE, 255)), tile.convert('RGBA')).convert('RGB')
    solid = tile.point(lambda v: 255 if v > 150 else 0).convert('L').point(lambda v: 255 if v > 80 else 0)
    left, top, right, bottom = solid.getbbox()
    mark = lifted(tile.crop((left - 8, top - 8, right + 8, bottom + 8)))
    mono = Image.new('RGBA', mark.size, (255, 255, 255, 0))
    mono.putalpha(mark.getchannel('A'))
    for density, scale in DENSITIES.items():
        side, width = round(LAYER_DP * scale), round(MARK_DP * scale)
        folder = RES / f'mipmap-{density}'
        folder.mkdir(exist_ok=True)
        for name, layer in (('ic_launcher_foreground', mark), ('ic_launcher_monochrome', mono)):
            fitted = layer.resize((width, round(layer.height * width / layer.width)), Image.Resampling.LANCZOS)
            canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            canvas.alpha_composite(fitted, ((side - fitted.width) // 2, (side - fitted.height) // 2))
            canvas.save(folder / f'{name}.png', optimize=True)
    print(f'{SOURCE.name}: mark {mark.width}x{mark.height} px -> {MARK_DP} dp on {LAYER_DP} dp layers in {len(DENSITIES)} densities')

if __name__ == '__main__':
    main()
