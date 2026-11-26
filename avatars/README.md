# 3D 人像

- `tw-female.glb`：Microsoft Rocketbox `Female_Adult_03`
- `tw-male.glb`：Microsoft Rocketbox `Male_Adult_09`

- `biz-f1.glb`／`biz-f2.glb`／`biz-m1.glb`／`biz-m2.glb`：Rocketbox `Business_Female_04`／`Business_Female_03`／`Business_Male_02`／`Business_Male_01`（`_facial.fbx`）。做法：FBX2glTF 轉檔 → `tools/fbx_blendshape_names.py` 補上表情名稱 → `tools/rocketbox_textures.py` 貼圖 1024＋插畫風平滑＋取頭髮顏色 → `tools/rocketbox_build.mjs` 只留 18 個表情、meshopt 壓縮（各約 0.4 MB）。網站載入時加上卡通著色與描邊（`#toon`）。

由原始 FBX 轉成 glb：只留手語用得到的 13 個臉部表情（ARKit 名稱）、貼圖縮成 1024 WebP、meshopt 壓縮（各約 1.3 MB）。

來源：https://github.com/microsoft/Microsoft-Rocketbox

MIT License — Copyright (c) Microsoft Corporation.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
