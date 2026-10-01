#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
字体切片工具：把 static/ 下的超大 CJK 字体切成 woff2 分片 + unicode-range CSS。

产出（static/fonts/）：
  SourceHanSerifCN.css + SourceHanSerifCN-<n>.woff2   —— 思源宋体切片
  AlibabaPuHuiTi.css    + AlibabaPuHuiTi-<n>.woff2    —— 阿里巴巴普惠体切片
  AlibabaSans.woff2 / TimesNewRoman.woff2 / Helvetica.woff2 —— 拉丁字体整包转换

生成的 CSS 里每个 @font-face 声明 font-family:"TinyChat Text"（与 ui.js 注入的
运行时字族同名），浏览器只下载页面实际用到的分片。重新生成只需：

  pip install fonttools brotli
  python tools/slice_fonts.py

仅需在字体文件更换或切片参数调整时重跑；日常发版不需要。
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, 'static')
OUT = os.path.join(STATIC, 'fonts')
# woff2 引用带生成日期版本号:字体文件被长缓存,重切后必须换 URL 才能刷新
GEN_V = time.strftime('%Y%m%d')

try:
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options
except ImportError:
    sys.exit('缺少依赖：pip install fonttools brotli')

# CJK 字体分片参数：单分片最多 512 个码位，遇超过 96 个码位的空洞就切开，
# 兼顾「单个 woff2 体积」与「一页中文要下载的分片数」。
SLICE_MAX = 512
GAP_SPLIT = 96
MIN_SLICE_CP = 24

# 与 static/js/ui.js 的 CJK_UNICODE_RANGE 保持一致:切片只覆盖 CJK 区段,
# 拉丁字形(思源宋体内置的拉丁)不切片,避免与「拉丁字体」分流的 unicode-range 抢匹配
CJK_BANDS_TEXT = ('2E80-2EFF,3000-303F,3040-30FF,3100-312F,31A0-31BF,'
                  '3400-4DBF,4E00-9FFF,F900-FAFF,FE30-FE4F,20000-2FA1F')


def parse_bands(text):
    bands = []
    for part in text.split(','):
        part = part.strip().replace('U+', '').replace('u+', '')
        if '-' in part:
            a, b = part.split('-')
            bands.append((int(a, 16), int(b, 16)))
        elif part:
            v = int(part, 16)
            bands.append((v, v))
    return bands


CJK_BANDS = parse_bands(CJK_BANDS_TEXT)

LATIN_FONTS = [
    ('AlibabaSans.ttf', 'AlibabaSans.woff2'),
    ('Times New Roman.ttf', 'TimesNewRoman.woff2'),
    ('Helvetica.ttf', 'Helvetica.woff2'),
]

CJK_FONTS = [
    ('SourceHanSerifCN.otf', 'SourceHanSerifCN'),
    ('AlibabaPuHuiTi.ttf', 'AlibabaPuHuiTi'),
]


def covered_codepoints(path):
    font = TTFont(path, lazy=True)
    best = None
    for table in font['cmap'].tables:
        if table.isUnicode():
            cps = set(table.cmap.keys())
            if best is None or len(cps) > len(best):
                best = cps
    order = font.getGlyphOrder()
    font.close()
    return sorted(best or set()), len(order)


def make_slices(cps):
    slices = []
    start = prev = None
    for cp in cps:
        if start is None:
            start = prev = cp
            continue
        gap = cp - prev
        size = prev - start + 1
        if (gap > GAP_SPLIT) or (size >= SLICE_MAX and gap > 1) or (size >= SLICE_MAX * 2):
            slices.append([start, prev])
            start = cp
        prev = cp
    if start is not None:
        slices.append([start, prev])
    # 合并碎片:少于 MIN_SLICE_CP 个码位的分片并入相邻分片,
    # 避免生僻区间产生大量 1~2KB 的小文件
    merged = []
    for s in slices:
        if merged and (s[1] - s[0] + 1) < MIN_SLICE_CP:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [(a, b) for a, b in merged]


def ranges_text(cps):
    """把一组码位压成 unicode-range 值(逗号分隔的 U+XXXX 或区间)。"""
    parts = []
    start = prev = None
    for cp in cps:
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            parts.append((start, prev))
            start = prev = cp
    if start is not None:
        parts.append((start, prev))
    out = []
    for a, b in parts:
        if a == b:
            out.append('U+%04X' % a)
        else:
            out.append('U+%04X-%04X' % (a, b))
    return ','.join(out)


def slice_cjk(src, stem):
    cps, glyph_count = covered_codepoints(os.path.join(STATIC, src))
    cps = [cp for cp in cps if any(a <= cp <= b for a, b in CJK_BANDS)]
    if not cps:
        raise SystemExit('%s 在 CJK 区段内没有字形覆盖' % src)
    slices = make_slices(cps)
    faces = []
    total = 0
    for i, (a, b) in enumerate(slices):
        group = [cp for cp in cps if a <= cp <= b]
        opts = Options()
        opts.flavor = 'woff2'
        opts.ignore_missing_glyphs = True
        opts.ignore_missing_unicodes = True
        # 只保留横向排版需要的 OpenType 特性;竖排表全部丢弃(聊天界面用不到)
        opts.layout_features = ['ccmp', 'liga', 'kern', 'mark', 'mkmk']
        opts.drop_tables += ['VORG', 'VHEA', 'VMTX']
        # 注意:这里刻意不做 desubroutinize——分片后每个文件很小,
        # 保留 CFF 子程序让 brotli 在分片内部仍有冗余可压,总体积明显更小
        opts.name_IDs = [0, 1, 2, 3, 4, 6]
        opts.notdef_outline = True
        ss = Subsetter(opts)
        font = TTFont(os.path.join(STATIC, src))
        ss.populate(unicodes=group)
        ss.subset(font)
        fname = '%s-%03d.woff2' % (stem, i)
        outpath = os.path.join(OUT, fname)
        font.save(outpath)
        font.close()
        size = os.path.getsize(outpath)
        total += size
        faces.append((fname, ranges_text(group), size))
        print('  %-28s %5d 码位  %7.1f KB' % (fname, len(group), size / 1024))
    css = ['/* 由 tools/slice_fonts.py 生成，勿手改；重跑脚本可再生成 */']
    css.append('/* %s：%d 个字形 → %d 个 woff2 分片，合计 %.1f MB（仅按需下载） */'
               % (stem, glyph_count, len(faces), total / 1024 / 1024))
    for fname, ranges, _ in faces:
        css.append(
            '@font-face{font-family:"TinyChat Text";font-style:normal;font-weight:200 900;'
            'font-display:swap;src:url("./%s?v=%s") format("woff2");unicode-range:%s;}'
            % (fname, GEN_V, ranges))
    with open(os.path.join(OUT, stem + '.css'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(css) + '\n')
    print('%s → %d 分片，合计 %.1f MB' % (stem, len(faces), total / 1024 / 1024))


def convert_latin(src, dst):
    from fontTools.ttLib import TTFont as TF
    font = TF(os.path.join(STATIC, src))
    font.flavor = 'woff2'
    outpath = os.path.join(OUT, dst)
    font.save(outpath)
    font.close()
    print('  %-28s → %-22s %7.1f KB' % (src, dst, os.path.getsize(outpath) / 1024))


def main():
    os.makedirs(OUT, exist_ok=True)
    for src, stem in CJK_FONTS:
        print('切片 %s ...' % src)
        slice_cjk(src, stem)
    print('整包转换拉丁字体 ...')
    for src, dst in LATIN_FONTS:
        convert_latin(src, dst)
    print('完成。输出目录：static/fonts/')


if __name__ == '__main__':
    main()
