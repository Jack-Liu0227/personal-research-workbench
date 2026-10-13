# 第三方组件与许可（sidecars/research-workbench-py）

本目录随 Electron 主程序一起分发：`apps/desktop/electron-builder.yml` 里 `extraResources`
把整个 `sidecars/` 目录**原样复制**进安装包的 `resources/sidecars/`，没有过滤规则。
所以这张表不只是「记录」，它是分发时必须随附的许可声明。

选型红线（见仓库 `AGENTS.md` 与 `.agents/roles/review-security.md`）：
**GPL / AGPL 只作参考，不作直接依赖**；许可不明的一律先查清再入库。

## 一、前端内置库（`web/vendor/`）

| 文件 / 目录 | 上游 | 版本 | 许可 | 版权归属 |
| --- | --- | --- | --- | --- |
| `lunar/lunar.js` | [6tail/lunar-javascript](https://github.com/6tail/lunar-javascript) | 1.6.12（**本地改过 1 处**，见下） | MIT | Copyright (c) 2018 6tail |
| `katex/`（含 60 个字体） | [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.22 | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors |
| `marked/marked.umd.js` | [marked](https://github.com/markedjs/marked) | 15.0.12 | MIT | Copyright (c) 2011-2025, Christopher Jeffrey and contributors |
| `dompurify/purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.6 | Apache-2.0 **或** MPL-2.0 | Copyright Cure53 / DOMPurify contributors |
| `pdfjs/pdf.min.js`、`pdfjs/pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 3.11.174 | Apache-2.0 | Copyright 2023 Mozilla Foundation |
| `kb3d.js` | 逐字照 [csuyincs-creator/Baixiao-Reading-Cockpit](https://github.com/csuyincs-creator/Baixiao-Reading-Cockpit) 的实现 | — | MIT | Copyright (c) 2026 YCS |
| `splash.js` | Originkit（Globe Study / Vector Wordmark）+ magicui（Interactive Hover Button），由 React/TSX 源码手工转写成原生 JS | — | MIT | Originkit: Copyright (c) 2026 Vellum, Inc.；magicui: MIT |
| `img/` | 本项目自有素材 | — | 随本项目 | — |

### 关于 `lunar.js` 的改动（重要）

仓库里这份 `lunar.js` **不是**上游原样文件，已核实如下：

- 上游 v1.6.12 为 8495 行；仓库内为 8494 行，且整文件是 **CRLF** 行尾（Windows 下编辑过）。
- 归一化行尾后，与上游 v1.6.12 逐行对比：**仅 1 处内容不同**（`_NAMES_IN_USE` / `_DATA`
  那一行的长字符串），其余全部一致。
- 早期版本比对显示它**不是** v1.7.7（曾一度被误标）：与 v1.7.7 差异明显，与 **v1.6.12 最接近**。

也就是说，这是「**lunar-javascript v1.6.12 + 本地一处改动**」。MIT 允许修改与再分发，
**义务是保留版权与许可声明**。上游文件本身没有在源码头部写许可（只放在仓库的 LICENSE
文件里），vendoring 时那份声明没被一起带过来 —— 这就是本文件存在的意义，它补上了这道义务。
**不要**把这里的 lunar.js 换成上游新版本：那会改动 400 KB 库代码，属于本任务范围外的行为变更。

### 关于 `kb3d.js`

文件头自己写明「逐字照 Baixiao-Reading-Cockpit 的实现」「着色器从参考插件原样搬」。
已核实该上游项目为 MIT（`Copyright (c) 2026 YCS`），故**可用**，但必须保留声明 —— 已在本表补齐。

### 关于 `splash.js`

三个组件分别来自 Originkit 与 magicui，都是 MIT。文件由作者手工从 React/TSX 转成原生 JS
（本项目无构建步骤），只改了文案与尺寸。属于「修改后的再分发」，同样以保留声明履行义务。

## 二、Python 依赖

精确版本与选型理由见 [`requirements.txt`](requirements.txt)，该文件逐行标注了许可证：

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `pypdf` | 6.16.2 | BSD-3-Clause | 页数 / 页面合并（`pdfio.py`） |
| `pdfplumber` | 0.11.10 | MIT | 文本与词坐标（`pdfio.py`） |
| `python-docx` | 1.2.0 | MIT | 导出 Word（`workflow.py`） |
| `pywebview` | 6.2.1 | BSD-3-Clause | 桌面窗口（`server.py`） |
| `PyYAML` | 6.0.3 | MIT | 读配置（`server.py`） |
| `pywin32` | 312 | PSF-2.0 | 可选，仅 `installer.py` 用 |

传递依赖（`pdfminer.six`、`pypdfium2`、`pillow`、`cryptography`）均为 MIT / Apache-2.0 /
BSD-3-Clause 一类宽松许可，无 GPL / AGPL。

**PDF 解析已从 PyMuPDF（AGPL）迁出**：改用 `pdfplumber` + `pypdf`，实现统一收在
[`pdfio.py`](pdfio.py)。这是本项目早期的合规决策，勿回退。

## 三、MIT 许可全文

以下文本适用于上表中所有标注 MIT 的组件（各组件版权分别归其署名者所有）：

```text
MIT License

Copyright (c) <year> <copyright holder>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Apache-2.0 组件的完整许可文本已随文件本体保留：`pdfjs/pdf.min.js` 与
`pdfjs/pdf.worker.min.js` 开头即 `@licstart ... Copyright 2023 Mozilla Foundation ...`。
Apache-2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

## 四、尚未闭合的两点

1. **本仓库自身没有 LICENSE**（根 `package.json` 的 `license` 为 `null`，也没有 `LICENSE` 文件）。
   内部使用无碍；一旦要公开分发或接受外部贡献，需要先补一个。
2. 上表若将来新增内置库，**必须同步登记**。`sidecars/` 是整目录进安装包的，
   任何新放进 `web/vendor/` 的文件都会随包分发出去，漏登记就是漏分发许可。
