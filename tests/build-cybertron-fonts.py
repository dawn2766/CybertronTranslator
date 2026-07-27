from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
GLYPH_ROOT = ROOT / "app" / "assets" / "glyphs"
FONT_ROOT = ROOT / "app" / "assets" / "fonts"
FAMILIES = {
    "autobot": "Cybertron Autobot",
    "decepticon": "Cybertron Decepticon",
}
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
UNITS_PER_EM = 1000
CELL_HEIGHT = 1000
BASELINE = 0
HORIZONTAL_SCALE = 0.68
SIDE_BEARING = 8
ALPHA_THRESHOLD = 72
OUTLINE_OVERSAMPLE = 2
OUTLINE_BLUR_RADIUS = 0.55
CONTOUR_EPSILON = 0.85
MIN_CONTOUR_AREA = 3.0


def build_glyph(path: Path):
    image = Image.open(path).convert("RGBA")
    alpha = image.getchannel("A")
    visible_bounds = alpha.getbbox()
    if visible_bounds is None:
        raise ValueError(f"{path} has no visible pixels")
    if visible_bounds[0] != 0 or visible_bounds[2] != image.width:
        raise ValueError(f"{path} still has horizontal transparent margins: {visible_bounds}")

    alpha = alpha.resize(
        (image.width * OUTLINE_OVERSAMPLE, image.height * OUTLINE_OVERSAMPLE),
        Image.Resampling.LANCZOS,
    ).filter(ImageFilter.GaussianBlur(OUTLINE_BLUR_RADIUS))

    vertical_scale = CELL_HEIGHT / alpha.height
    horizontal_scale = vertical_scale * HORIZONTAL_SCALE
    pen = TTGlyphPen(None)
    mask = np.asarray(alpha, dtype=np.uint8)
    _, binary = cv2.threshold(mask, ALPHA_THRESHOLD, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    traced_contours = 0
    traced_points = 0
    for contour in contours:
        if abs(cv2.contourArea(contour)) < MIN_CONTOUR_AREA:
            continue
        simplified = cv2.approxPolyDP(contour, CONTOUR_EPSILON, True)
        points = simplified.reshape(-1, 2)
        if len(points) < 3:
            continue
        mapped = [
            (
                SIDE_BEARING + round(int(x) * horizontal_scale),
                BASELINE + round((alpha.height - int(y)) * vertical_scale),
            )
            for x, y in points
        ]
        pen.moveTo(mapped[0])
        for point in mapped[1:]:
            pen.lineTo(point)
        pen.closePath()
        traced_contours += 1
        traced_points += len(mapped)

    if traced_contours == 0:
        raise ValueError(f"{path} produced no contours")

    advance = SIDE_BEARING * 2 + round(alpha.width * horizontal_scale)
    return pen.glyph(), advance, traced_contours, traced_points


def build_font(family_id: str, family_name: str) -> Path:
    glyph_order = [".notdef", "space", *LETTERS]
    glyphs = {}
    metrics = {}

    empty_pen = TTGlyphPen(None)
    glyphs[".notdef"] = empty_pen.glyph()
    metrics[".notdef"] = (500, 0)
    glyphs["space"] = TTGlyphPen(None).glyph()
    metrics["space"] = (280, 0)

    for letter in LETTERS:
        glyph, advance, contour_count, point_count = build_glyph(GLYPH_ROOT / family_id / f"{letter}.png")
        glyphs[letter] = glyph
        metrics[letter] = (advance, 0)
        if contour_count > 80 or point_count > 900:
            raise ValueError(
                f"{family_id}/{letter} contour is unexpectedly complex: "
                f"{contour_count} contours, {point_count} points"
            )

    builder = FontBuilder(UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder(glyph_order)
    cmap = {32: "space"}
    cmap.update({ord(letter): letter for letter in LETTERS})
    cmap.update({ord(letter.lower()): letter for letter in LETTERS})
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=1000, descent=0, lineGap=0)
    builder.setupNameTable({
        "familyName": family_name,
        "styleName": "Regular",
        "uniqueFontIdentifier": f"Cybertron:{family_id}:1.0",
        "fullName": family_name,
        "psName": family_name.replace(" ", "-"),
        "version": "Version 1.0",
    })
    builder.setupOS2(
        sTypoAscender=1000,
        sTypoDescender=0,
        sTypoLineGap=0,
        usWinAscent=1000,
        usWinDescent=0,
        sxHeight=750,
        sCapHeight=1000,
    )
    builder.setupPost()
    builder.setupMaxp()
    builder.font.recalcTimestamp = False
    builder.font["head"].created = 2082844800
    builder.font["head"].modified = 2082844800

    FONT_ROOT.mkdir(parents=True, exist_ok=True)
    destination = FONT_ROOT / f"cybertron-{family_id}.woff2"
    builder.font.flavor = "woff2"
    builder.font.save(destination)
    return destination


def verify_font(path: Path, family_name: str) -> None:
    if path.read_bytes()[:4] != b"wOF2":
        raise ValueError(f"{path} is not a WOFF2 file")
    font = TTFont(path)
    cmap = font.getBestCmap()
    expected_codepoints = {ord(character) for character in LETTERS + LETTERS.lower()}
    if not expected_codepoints.issubset(cmap):
        raise ValueError(f"{path} is missing A-Z or a-z mappings")
    if {cmap[ord(letter)] for letter in LETTERS} != set(LETTERS):
        raise ValueError(f"{path} does not contain 26 distinct uppercase glyph mappings")
    if any(cmap[ord(letter.lower())] != letter for letter in LETTERS):
        raise ValueError(f"{path} lowercase mappings differ from uppercase glyphs")
    stored_family_names = {
        record.toUnicode()
        for record in font["name"].names
        if record.nameID == 1
    }
    if family_name not in stored_family_names:
        raise ValueError(f"{path} family name is not {family_name!r}")
    advances = [font["hmtx"].metrics[letter][0] for letter in LETTERS]
    if min(advances) <= SIDE_BEARING * 2 or max(advances) >= UNITS_PER_EM:
        raise ValueError(f"{path} has invalid compressed advances: {min(advances)}..{max(advances)}")


def main() -> None:
    outputs = [build_font(family_id, family_name) for family_id, family_name in FAMILIES.items()]
    for (family_id, family_name), output in zip(FAMILIES.items(), outputs, strict=True):
        verify_font(output, family_name)
        print(f"Built and verified {output.relative_to(ROOT)} ({output.stat().st_size} bytes, family={family_id})")
    print(
        f"Horizontal outline scale: {HORIZONTAL_SCALE:.0%}; "
        f"outline smoothing: {OUTLINE_OVERSAMPLE}x / blur {OUTLINE_BLUR_RADIUS}; "
        f"contour epsilon: {CONTOUR_EPSILON}."
    )


if __name__ == "__main__":
    main()