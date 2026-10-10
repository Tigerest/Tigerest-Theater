# Windows 每次更新的花屏必检

此项来自 2.5.3 再次出现的媒体夹海报墙悬停花屏。旧补丁已加载且同步日志正常，说明仅检查启动和补丁 SHA256 不足。已知复现未解决时不得签发通过记录。

## 自动检查：实际发行包的窗口像素

编译后在同一 PowerShell 中加载测试环境，再对最终便携目录运行。工具只采集真实屏幕上的客户端区域，不调用 WebEngine 截图，也不在应用渲染线程加入等待。它用本地海报 fixture、实际外观样式和转场缓存，在窗口、滚动后、全屏三种状态持续悬停。

```powershell
Get-Content dev/windows/TESTING.md | Out-Null
. ./dev/windows/Enter-TestEnvironment.ps1
node tests/test_windows_compositor.cjs 'build/portable/Tigerest Theater.exe' --webengine --capture=build/tests/windows_compositor_capture.exe --output=build/windows-release-visual
if ($LASTEXITCODE -ne 0) { throw 'Windows displayed-pixel check failed' }
```

需要可见且未遮挡的测试窗口。NVIDIA 全屏提示消失后才采样；其他浮窗或用户切换前台会使测试失败，必须检查失败截图再重试，不能将失败改为通过。负对照必须能识别故意设置的错误颜色。固定海报色块检查不覆盖全部像素和真实鼠标输入链路。

每次启动自动检查都会将旧报告作废；只有当次完整采样通过，`passed` 才为 true。失败或中断后不能继续使用上次的人工通过记录。

CI 对构建程序和最终便携目录均运行此检查，并保存 `windows-compositor-evidence`。CI 若使用 WARP 等软件设备，其报告不能签发硬件渲染通过；还须在实际硬件 GPU 上检查同一发行包。自动报告中的 `manual.passed` 默认是 false。

## 人工检查：真实媒体库及正常使用条件

使用独立人工测试配置，保留已安装播放器和原设置。不要把真实认证凭据复制到自动 fixture 中。按平时的显示器刷新率和鼠标回报率检查，不通过降频取得发布通过：

- 海报墙连续横向、纵向移动鼠标，快速移入/移出多个海报，至少 60 秒。
- 快速滚动后继续悬停，至少 60 秒；注意缺块、乱码、旧画面闪回和页面乱跳。
- 打开详情再返回海报墙，重复悬停。
- 实际播放后返回媒体库，重复悬停；注明实际播放验证结果。
- 全屏与窗口切换后重复悬停；等待外部浮窗消失，区分遮挡与花屏。
- 打开/关闭 MPV 设置后重复悬停。

全部完成且没有花屏，才在自动生成的 `report.json` 中填写人工记录：

```json
"manual": {
  "passed": true,
  "observedCorruption": false,
  "tester": "实际测试者",
  "checkedAt": "2026-10-10T23:00:00+08:00",
  "refreshHz": 240,
  "mouseHz": 1000,
  "scenarios": {
    "real-library-hover": true,
    "rapid-scroll-hover": true,
    "detail-return": true,
    "playback-return": true,
    "fullscreen": true,
    "settings-overlay": true
  }
}
```

时间、频率和结果必须据实填写；示例值不是通过记录。没测的项保留 false。若出现花屏，保留原始截图/录屏、触发页面、是否刚返回播放、GPU/驱动及两项频率，人工记录保持失败。

## 发布校验

将报告命名为 `TigerestTheater-版本-Windows-Visual-Check.json`，先用最终 ZIP 校验：

```powershell
python dev/windows/verify_compositor_release.py --report 'build/TigerestTheater-版本-Windows-Visual-Check.json' --bundle 'build/TigerestTheater-版本-x64.zip'
```

报告包含自动检查生成的 EXE 和进程实际加载的核心 DLL SHA256，不能使用旧版报告。通过后将报告作为该版本 GitHub **草稿**的附件保存。`publish-release` 会下载并校验此报告，缺失报告、人工未通过、软件渲染、像素失败、包内哈希不同均会停止。手工发布同样必须执行此校验；不能绕过流程。
