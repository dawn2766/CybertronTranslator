# Cybertron Browser Fonts

`cybertron-autobot.woff2` and `cybertron-decepticon.woff2` are generated from
the corresponding transparent PNGs under `../glyphs/`.

- The PNGs have zero fully transparent columns on the left and right.
- The JPG source is extracted at 4x resolution with bicubic supersampling and
  a continuous luminance-to-alpha edge ramp that suppresses near-white JPEG noise.
- The PNG artwork keeps its natural aspect ratio and remains the source asset.
- The font generator scales outline coordinates to 68% horizontally for
  compact prose layout.
- Font masks receive another 2x Lanczos pass and a light Gaussian blur before
  OpenCV traces and simplifies closed contours. This removes the old per-row
  rectangle staircase and resolves edges at roughly 1/8 source pixel.
- Uppercase and lowercase Latin letters map to the same 26 family glyphs.

Regenerate from the repository root:

```powershell
& .\tests\extract-dual-family-glyphs.ps1
& .\tests\prepare-transparent-glyphs.ps1
& python .\tests\build-cybertron-fonts.py
```

Install the generator dependencies from `tests/requirements-fonts.txt` in the
selected Python environment before running the Python command.