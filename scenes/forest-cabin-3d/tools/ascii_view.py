"""
ascii_view.py — 把 PNG 变成「不受预览归一化影响」的字符图（Lead 验收工具）

用法: python tools/ascii_view.py shots/r5-shot0.png [--w 56] [--h 22]

同时输出两张字符图：
  ① 亮度图： . : - = + * # % @   （从黑到白）
  ② 色相图： G=绿 Y=黄/土 T=棕 R=红 B=蓝/青 W=近白灰 K=黑
这样即使图片预览被自动提亮/压缩，也能从文本里读出真实的明暗与色彩分布。
"""
import sys
import os
from PIL import Image

LUM_RAMP = " .:-=+*#%@"


def hue_char(r, g, b, lum):
    mx, mn = max(r, g, b), min(r, g, b)
    sat = 0 if mx == 0 else (mx - mn) / mx
    if lum < 0.045:
        return "K"
    if sat < 0.10:
        return "W" if lum > 0.5 else "w"
    if b > r and b >= g:
        return "B"
    if g > r and g > b * 1.05:
        return "G" if lum < 0.45 else "g"
    if r > b * 1.25 and g > b * 1.15:
        return "Y" if g > r * 0.72 else "T"
    if r > g * 1.15:
        return "R"
    return "T"


def render(path, W=56, H=22):
    im = Image.open(path).convert("RGB")
    small = im.resize((W, H), Image.BILINEAR)
    lums = [[None] * W for _ in range(H)]
    hues = [[""] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            r, g, b = small.getpixel((x, y))
            lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            lums[y][x] = lum
            hues[y][x] = hue_char(r, g, b, lum)

    print(f"\n=== {os.path.basename(path)} ({im.size[0]}x{im.size[1]}) ===")
    print("亮度图（暗 → 亮： ' .:-=+*#%@'）")
    for y in range(H):
        print("  |" + "".join(LUM_RAMP[min(9, int(lums[y][x] * 10))] for x in range(W)) + "|")
    print("色相图（G/g绿 Y黄 T棕 R红 B蓝 W/w中性亮/暗 K黑）")
    for y in range(H):
        print("  |" + "".join(hues[y]) + "|")

    # 分区统计
    print("  分区（3x3）平均亮度：")
    for gy in range(3):
        row = []
        for gx in range(3):
            xs = range(gx * W // 3, (gx + 1) * W // 3)
            ys = range(gy * H // 3, (gy + 1) * H // 3)
            vals = [lums[y][x] for y in ys for x in xs]
            row.append(f"{sum(vals) / len(vals):.3f}")
        print("    " + "  ".join(row))
    allv = sorted(v for row in lums for v in row)
    n = len(allv)
    print(f"  中位={allv[n//2]:.3f}  5%={allv[int(n*.05)]:.3f}  95%={allv[int(n*.95)]:.3f}")
    # 色相占比
    flat = [hues[y][x] for y in range(H) for x in range(W)]
    from collections import Counter
    tot = len(flat)
    print("  色相占比: " + "  ".join(f"{k}={v/tot:.0%}" for k, v in Counter(flat).most_common()))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    W = H = None
    for a in sys.argv[1:]:
        if a.startswith("--w"):
            W = int(a.split("=")[-1]) if "=" in a else None
    if not args:
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shots")
        args = [os.path.join(base, f) for f in sorted(os.listdir(base)) if f.endswith(".png")][-2:]
    for p in args:
        if os.path.exists(p):
            render(p, W or 56, 22)
