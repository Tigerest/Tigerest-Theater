"""Generate Tigerest Theater icon and installer artwork from the approved master.

Requires Pillow. Run from the repository root:
    python tools/generate_brand_assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "resources" / "images" / "tigerest-icon-master.png"
GOLD = (255, 183, 20, 255)
DARK = (17, 17, 18, 255)


def clean_master() -> Image.Image:
    """Remove the generated checkerboard outside the rounded-square artwork."""
    source = Image.open(MASTER).convert("RGB")
    width, height = source.size
    pixels = source.load()
    mask = Image.new("L", source.size, 0)
    mask_pixels = mask.load()

    # The rounded black tile is a single horizontal span on every row. Find
    # that span from its dark edge and fill it; white details inside remain.
    for y in range(height):
        dark = [
            x for x in range(width)
            if max(pixels[x, y]) < 145 and max(pixels[x, y]) - min(pixels[x, y]) < 20
        ]
        if not dark:
            continue
        left, right = min(dark), max(dark)
        for x in range(left, right + 1):
            mask_pixels[x, y] = 255

    mask = mask.filter(ImageFilter.GaussianBlur(0.7))
    result = source.convert("RGBA")
    result.putalpha(mask)
    return result


def contained(image: Image.Image, size: tuple[int, int], padding: int = 0) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    available = (size[0] - padding * 2, size[1] - padding * 2)
    fitted = image.copy()
    fitted.thumbnail(available, Image.Resampling.LANCZOS)
    canvas.alpha_composite(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return canvas


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    candidates = [Path("C:/Windows/Fonts") / name, Path("/System/Library/Fonts/SFNS.ttf")]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def wizard_image(icon: Image.Image) -> Image.Image:
    width, height = 534, 1022
    canvas = Image.new("RGB", (width, height), DARK[:3])
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 11, height), fill=GOLD[:3])
    badge = contained(icon, (340, 340), padding=10)
    canvas.paste(badge, ((width - badge.width) // 2, 245), badge)

    title_font = font(54, bold=True)
    sub_font = font(25)
    title = "TIGEREST"
    subtitle = "THEATER"
    title_box = draw.textbbox((0, 0), title, font=title_font)
    sub_box = draw.textbbox((0, 0), subtitle, font=sub_font)
    draw.text(((width - (title_box[2] - title_box[0])) / 2, 626), title, font=title_font, fill=GOLD[:3])
    draw.text(((width - (sub_box[2] - sub_box[0])) / 2, 696), subtitle, font=sub_font, fill=(235, 235, 235))
    draw.rounded_rectangle((145, 758, 389, 762), radius=2, fill=(70, 70, 72))
    return canvas


def wordmark(icon: Image.Image) -> Image.Image:
    """Create the transparent logo used while the default Emby server connects."""
    width, height = 1302, 378
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    badge = contained(icon, (350, 350), padding=8)
    canvas.alpha_composite(badge, (14, (height - badge.height) // 2))

    draw = ImageDraw.Draw(canvas)
    title_font = font(112, bold=True)
    subtitle_font = font(50)
    text_x = 410
    draw.text((text_x, 78), "TIGEREST", font=title_font, fill=GOLD)
    draw.text((text_x + 5, 220), "THEATER", font=subtitle_font, fill=(245, 245, 245, 255))
    return canvas


def main() -> None:
    icon = clean_master()
    image_dir = ROOT / "resources" / "images"
    win_dir = ROOT / "bundle" / "win"
    osx_dir = ROOT / "bundle" / "osx"
    native_dir = ROOT / "native"

    contained(icon, (512, 512), padding=2).save(image_dir / "icon.png", optimize=True)
    contained(icon, (256, 256), padding=1).save(win_dir / "wizard-small-image.png", optimize=True)
    wizard_image(icon).save(win_dir / "wizard-image.png", optimize=True)
    wordmark(icon).save(native_dir / "logo.png", optimize=True)

    ico = contained(icon, (256, 256), padding=1).convert("RGBA")
    ico.save(
        win_dir / "tigerest.ico",
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    icns = contained(icon, (1024, 1024), padding=4)
    icns.save(
        osx_dir / "tigerest.icns",
        format="ICNS",
        sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)],
    )

    print("Generated Tigerest icon.png, wordmark, ICO, ICNS, and Inno Setup wizard artwork.")


if __name__ == "__main__":
    main()
