from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


FONT_DIRECTORY = Path(__file__).resolve().parents[1] / "app" / "assets" / "fonts"
FONT_NAMES = ("cybertron-autobot.woff2", "cybertron-decepticon.woff2")
TARGET_BOTTOM = 25
TARGET_TOP = 975


def get_bounds(font, glyph_names):
    glyph_set = font.getGlyphSet()
    bounds = []
    for glyph_name in glyph_names:
        pen = BoundsPen(glyph_set)
        glyph_set[glyph_name].draw(pen)
        if pen.bounds:
            bounds.append(pen.bounds)
    return (
        min(bound[0] for bound in bounds),
        min(bound[1] for bound in bounds),
        max(bound[2] for bound in bounds),
        max(bound[3] for bound in bounds),
    )


def normalize_font(path):
    font = TTFont(path, recalcBBoxes=True, recalcTimestamp=False)
    cmap = font.getBestCmap()
    glyph_names = sorted({cmap[codepoint] for codepoint in range(ord("A"), ord("Z") + 1)})
    before = get_bounds(font, glyph_names)
    scale = (TARGET_TOP - TARGET_BOTTOM) / (before[3] - before[1])
    translate_y = TARGET_BOTTOM - before[1] * scale

    glyf = font["glyf"]
    hmtx = font["hmtx"]
    glyph_set = font.getGlyphSet()
    for glyph_name in glyph_names:
        glyph_pen = TTGlyphPen(glyph_set)
        transform_pen = TransformPen(glyph_pen, (scale, 0, 0, scale, 0, translate_y))
        glyph_set[glyph_name].draw(transform_pen)
        glyf[glyph_name] = glyph_pen.glyph()
        advance_width, left_side_bearing = hmtx[glyph_name]
        hmtx[glyph_name] = (round(advance_width * scale), round(left_side_bearing * scale))

    font.save(path, reorderTables=False)
    updated_font = TTFont(path)
    after = get_bounds(updated_font, glyph_names)
    if round(after[1]) != TARGET_BOTTOM or round(after[3]) != TARGET_TOP:
        raise RuntimeError(f"{path.name} has unexpected vertical bounds: {after}")
    print(f"{path.name}: {before} -> {after}, scale={scale:.4f}")


for font_name in FONT_NAMES:
    normalize_font(FONT_DIRECTORY / font_name)