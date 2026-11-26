#!/usr/bin/env python3
"""rocketbox_textures.py — Rocketbox 貼圖縮成 1024，並做成「插畫風」：保留邊緣的平滑（去掉照片雜訊）、色彩稍微飽和。

用法：python tools/rocketbox_textures.py 貼圖資料夾 輸出資料夾 [--plain]
  輸出 body.jpg、head.jpg（顏色）、opacity.png（睫毛、頭髮邊緣的透明度）
"""
import sys, glob, os
import cv2, numpy as np
from PIL import Image


def load(f, mode):   # OpenCV 讀不了 TGA，用 PIL 讀再轉成 OpenCV 的 BGR
    a = np.array(Image.open(f).convert(mode))
    return a[..., ::-1].copy() if mode == 'RGB' else a

src, dst = sys.argv[1], sys.argv[2]
plain = '--plain' in sys.argv
os.makedirs(dst, exist_ok=True)


def illus(img, strong):
    img = cv2.edgePreservingFilter(img, flags=1, sigma_s=strong, sigma_r=0.35)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.12, 0, 255)
    img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return img


for kind, strong in (('body', 50), ('head', 25)):
    f = glob.glob(os.path.join(src, f'*_{kind}_color.tga'))[0]
    img = cv2.resize(load(f, 'RGB'), (1024, 1024), interpolation=cv2.INTER_AREA)
    if not plain:
        img = illus(img, strong)
    cv2.imwrite(os.path.join(dst, f'{kind}.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
f = glob.glob(os.path.join(src, '*_opacity_color.tga'))[0]
a = load(f, 'RGBA')[..., 3]
rgba = np.dstack([np.full_like(a, 255)] * 3 + [a])
cv2.imwrite(os.path.join(dst, 'opacity.png'), cv2.resize(rgba, (512, 512), interpolation=cv2.INTER_AREA))
# 頭髮顏色：頭部貼圖裡最暗的那群像素的中位數（髮片用這個顏色，不然會是灰色）
h = load(glob.glob(os.path.join(src, '*_head_color.tga'))[0], 'RGB')[..., ::-1].reshape(-1, 3).astype(np.float32)
lum = h @ np.array([0.3, 0.59, 0.11])
h = h[lum > 10]; lum = lum[lum > 10]   # 去掉貼圖空白處的純黑
dark = h[lum <= np.percentile(lum, 12)]
col = np.median(dark, 0) / 255 * 0.8
open(os.path.join(dst, 'hair.txt'), 'w').write(','.join(f'{c:.3f}' for c in col))
print('貼圖完成：', dst, '頭髮顏色', col.round(2))
