# Windows 测试启动环境

原生测试程序位于 `build/tests`，没有安装包旁的完整运行库和 `qt.conf`。直接运行会弹出缺少 `libmpv-2.dll` 或 Qt platform plugin 错误框。**每次测试都必须在同一个 PowerShell 进程中先加载环境脚本**；上一次工具调用中的环境变量不会延续。

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1
ctest --test-dir build --output-on-failure --timeout 180
```

使用其他构建目录：

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1 -BuildDirectory 'D:/build/tigerest'
ctest --test-dir 'D:/build/tigerest' --output-on-failure --timeout 180
```

脚本从 CMakeCache 读取 Qt、MPV 和工具路径，检查 DLL、`qwindows.dll` 和 `qoffscreen.dll`，设置 PATH、QT_PLUGIN_PATH、QT_QPA_PLATFORM_PLUGIN_PATH 和 Qt 控制台日志。缺失文件时直接报错，停止测试；不要靠反复启动程序查缺哪一个 DLL，也不要修改用户已安装播放器解决测试环境问题。更新器回归包含真实的 2／5／10／20／30 秒重试等待，整套测试的单项超时应保留 180 秒。

无窗口的单项策略测试可以额外设置 `QT_QPA_PLATFORM=offscreen`；真正的窗口、WebEngine、播放测试使用默认 Windows 平台，不要把 offscreen 留给整套测试。Qt GUI 测试需要文字报告时加 `-o 路径,txt`，避免把无 stdout 误判为未执行：

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1
$env:QT_QPA_PLATFORM = 'offscreen'
./build/tests/test_windowmanager.exe testMovingToAnotherScreenRefreshesPlaybackPolicy -o build/screen-policy.txt,txt
Get-Content build/screen-policy.txt
```

先按 `dev/windows/build.bat` 配置并编译，再测试；完整客户端检查前用 `cmake --install build` 更新暂存包。消息 UI 测试用隔离账号 fixture：

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1
node tests/test_community_messages_ui.cjs 'build/output/Tigerest Theater.exe' --webengine
```

播放测试使用独立配置目录，不复制真实认证凭据到 fixture，也不向生产评论服务写入测试评论或已读状态。屏幕刷新率如临时改变，结束时必须恢复。此前的两个启动错误分别来自遗漏 MPV DLL 路径和遗漏 Qt 平台插件路径；都属于测试环境，不代表播放器需要重装。

不要额外把 QTWEBENGINEPROCESS_PATH／RESOURCES_PATH／LOCALES_PATH 指向未经部署的 QtWebEngine 构建目录。集成测试使用应用自身的部署资源；混用目录会令页面执行超时，即使旧安装版也会复现。独立发行包冒烟测试应移除工具链 PATH 和 Qt 环境覆盖，确认只靠包内运行库启动。

环境脚本会从当前测试进程的附加 PATH 中排除其他工具自带的 OpenSSL DLL 目录，避免 Qt 混用不同来源的 libssl／libcrypto 后在 TLS 初始化中阻塞；播放器暂存包的运行库目录仍优先保留，不修改系统 PATH。

`test_window_chrome` 的无边框最大化按钮检查会选择可用工作区小于整屏区域的显示器。若所有显示器的工作区都等于整屏，Qt 6.9 Windows 插件会在尺寸事件后把无边框最大化识别为全屏，该单个用例会明确跳过并说明原因；最小化、关闭、全屏、缩放边缘等检查继续执行。发布验证清单必须记录这个跳过项，不能把 CTest 可执行目标全部通过当作所有 Qt 用例均已执行。

`test_webengine_runtime_deployment` 检查缺少同步补丁运行库、版本或 SHA256 不匹配时配置必须失败。`test_webengine_startup` 除软件渲染参数检查外，还使用独立临时配置启动正常硬件加速窗口，确认 D3D11 合成启用且日志实际出现 `D3D11 producer wait: completed=1, reset=0`。该测试不能代替媒体库悬停、滚动时的实际画面检查；不能因软件渲染测试通过就宣称花屏已修复。

`test_windows_compositor` 采集前台 Windows 窗口的真实客户端像素，检查海报墙连续悬停、滚动后及全屏状态下的固定海报区域，并保存失败帧；它不使用 CDP 截图作为窗口合成通过证据。窗口被遮挡、切换前台、样本不足均失败。发布必须再对最终便携包运行，并完成 [每次更新花屏必检](RELEASE_CHECKLIST.md) 的真实媒体库人工记录。自动 fixture 通过不代表本次用户报告已解决。
