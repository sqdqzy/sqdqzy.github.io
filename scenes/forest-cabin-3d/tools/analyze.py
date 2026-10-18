"""
analyze.py — 画面亮度/对比度体检（Lead 验收工具，不参与网页运行）

用法:
  python tools/analyze.py shots/r4-front.png [more.png ...]

输出每张图的：
  · 平均/中位亮度（0..1，sRGB 显示值）—— 电影感参考区间：均值 0.28~0.40
  · 直方图分位（是否死黑 / 高光溢出）
  · 暗部裁切比例（<0.02）与高光裁切比例（>0.98）
  · 颜色丰富度（饱和度均值）与冷暖倾向（R-B 均值）
  · 九宫格分区亮度（检查画面重心与光影分布）
"""
import sys
import os
from PIL import Image

REF_MEAN = (0.255, 0.42)      # 期望的平均亮度区间
REF_CLIP_DARK = 0.14          # 死黑像素比例上限
REF_CLIP_LIGHT = 0.06         # 高光溢出比例上限


def srgb_lum(r, g, b):
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def analyze(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    small = im.resize((256, 144), Image.BILINEAR)
    px = list(small.getdata())

    lums = sorted(srgb_lum(*p) for p in px)
    n = len(lums)
    mean = sum(lums) / n
    median = lums[n // 2]
    p05, p25, p75, p95 = lums[int(n * .05)], lums[int(n * .25)], lums[int(n * .75)], lums[int(n * .95)]
    dark_clip = sum(1 for v in lums if v < 0.02) / n
    light_clip = sum(1 for v in lums if v > 0.98) / n

    sat_sum = 0.0
    warm_sum = 0.0
    for r, g, b in px:
        mx, mn = max(r, g, b), min(r, g, b)
        sat_sum += 0 if mx == 0 else (mx - mn) / mx
        warm_sum += (r - b) / 255.0
    sat = sat_sum / n
    warm = warm_sum / n

    # 九宫格亮度
    grid = []
    for gy in range(3):
        row = []
        for gx in range(3):
            cell = [small.getpixel((x, y)) for y in range(gy * 48, (gy + 1) * 48, 3) for x in range(gx * 85, (gx + 1) * 85, 3)]
            row.append(sum(srgb_lum(*c) for c in cell) / len(cell))
        grid.append(row)

    name = os.path.basename(path)
    flags = []
    if mean < REF_MEAN[0]:
        flags.append(f"欠曝(均值 {mean:.3f} < {REF_MEAN[0]})")
    if mean > REF_MEAN[1]:
        flags.append(f"过曝(均值 {mean:.3f} > {REF_MEAN[1]})")
    if dark_clip > REF_CLIP_DARK:
        flags.append(f"死黑过多 {dark_clip:.1%}")
    if light_clip > REF_CLIP_LIGHT:
        flags.append(f"高光溢出 {light_clip:.1%}")
    if sat < 0.12:
        flags.append(f"过于灰淡(饱和 {sat:.2f})")

    print(f"\n=== {name}  {W}x{H} ===")
    print(f"  亮度 mean={mean:.3f} median={median:.3f}  p05={p05:.3f} p25={p25:.3f} p75={p75:.3f} p95={p95:.3f}")
    print(f"  动态范围 p95-p05 = {p95 - p05:.3f}   死黑={dark_clip:.1%}  溢出={light_clip:.1%}")
    print(f"  饱和度={sat:.3f}  冷暖(R-B)={warm:+.3f}  {'偏暖' if warm > 0.02 else '偏冷' if warm < -0.02 else '中性'}")
    print("  九宫格亮度:")
    for row in grid:
        print("    " + "  ".join(f"{v:.3f}" for v in row))
    print("  判定: " + ("；".join(flags) if flags else "OK（曝光与动态范围合理）"))
    return {"mean": mean, "median": median, "sat": sat, "warm": warm, "dark": dark_clip, "light": light_clip, "range": p95 - p05}


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shots")
        args = [os.path.join(base, f) for f in sorted(os.listdir(base)) if f.endswith(".png")][-6:]
    for p in args:
        if os.path.exists(p):
            analyze(p)
        else:
            print(f"missing: {p}")
