# 空钩子：顶掉 PyInstaller 自带的 _pyinstaller_hooks_contrib/stdhooks/hook-workflow.py。
# 那个钩子是给 PyPI 上的 `workflow` 包用的，和我们本地的 workflow.py 同名撞车 ——
# 不顶掉的话打包会报 ImportErrorWhenRunningHook: Failed to import module
# __PyInstaller_hooks_0_workflow。这个项目不使用 PyPI 的 workflow 包，所以这里留空即可。
