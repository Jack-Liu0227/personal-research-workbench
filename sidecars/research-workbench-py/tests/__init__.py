# -*- coding: utf-8 -*-
"""测试包：把 tests/ 自身和上层（应用模块所在目录）都挂进 sys.path。

这样 `python -m unittest discover -s tests -t .` 和 `cd tests && python -m unittest` 都能跑，
tests/ 下的辅助模块（_pdf_fixture.py）也能被直接 import。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)
