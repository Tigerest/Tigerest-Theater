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

先按 `dev/windows/build.bat` 配置并编译，再测试；完整客户端检查前用 `cmake --install build` 更新暂存包。另开的构建目录也必须先 `cmake --install`：未暂存时 PATH 会落到 Qt 自带的原版 `Qt6WebEngineCore.dll`，没有 D3D11 同步等补丁，窗口会花屏；`Enter-TestEnvironment.ps1` 发现暂存的 `Qt6WebEngineCore.dll` 缺失或与补丁运行库清单的 SHA256 不符时直接报错。消息 UI 测试用隔离账号 fixture：

```powershell
. ./dev/windows/Enter-TestEnvironment.ps1
node tests/test_community_messages_ui.cjs 'build/output/Tigerest Theater.exe' --webengine
```

转场帧间隔：设 `TIGEREST_FRAME_TIMES=<文件>` 启动客户端，主窗口每次 `frameSwapped` 记一行墙钟毫秒（小数三位），由单独线程每 250 ms 写盘；不设置时不启动。这是屏幕实际换上新画面的时间，比页面里的 `requestAnimationFrame` 间隔可靠（页面主线程忙时 rAF 会拉长，合成器上的动画照常走）。不要再用 `QT_LOGGING_RULES=qt.scenegraph.time.renderloop.debug=true` 加 `--log-level debug` 的 "Frame prepared" 计时：调试日志会连带打开诊断上报的日志，日志本身就会拖出卡顿。也不要在录屏的同时测：DXGI 桌面复制会让网页合成掉到 130–180 帧，录屏只用来看画面有没有突变。

着色器缓存：客户端默认把 GPU 程序缓存放在当前配置的 `GPUCache`，安装版重启后的第一次转场不需要编译。测试用的全新配置副本缓存是空的，第一次转场会多一次约 65 ms 的着色器编译卡顿；要模拟安装版，把 `TIGEREST_WEBENGINE_SHADER_CACHE` 指到临时目录并在多次运行之间保留它（不要指向已安装播放器的配置）。报告第一次转场的数字时注明缓存是冷还是热。

转场卡顿诊断：设 `TIGEREST_THREAD_SAMPLES=<文件>` 启动客户端，`src/utils/win/ThreadSampler.cpp` 每毫秒采样 GUI、Qt 渲染、Chromium GPU／合成线程和页面渲染进程主线程的调用栈，写成 TSV（时间戳、线程、模块+偏移）；不设置时不启动。采样会略微拖慢页面，只用来找卡顿时各线程在做什么，不要拿采样运行的帧间隔当结论。

播放测试使用独立配置目录，不复制真实认证凭据到 fixture，也不向生产评论服务写入测试评论或已读状态。屏幕刷新率如临时改变，结束时必须恢复。此前的两个启动错误分别来自遗漏 MPV DLL 路径和遗漏 Qt 平台插件路径；都属于测试环境，不代表播放器需要重装。

不要额外把 QTWEBENGINEPROCESS_PATH／RESOURCES_PATH／LOCALES_PATH 指向未经部署的 QtWebEngine 构建目录。集成测试使用应用自身的部署资源；混用目录会令页面执行超时，即使旧安装版也会复现。独立发行包冒烟测试应移除工具链 PATH 和 Qt 环境覆盖，确认只靠包内运行库启动。

环境脚本会从当前测试进程的附加 PATH 中排除其他工具自带的 OpenSSL DLL 目录，避免 Qt 混用不同来源的 libssl／libcrypto 后在 TLS 初始化中阻塞；播放器暂存包的运行库目录仍优先保留，不修改系统 PATH。

`test_window_chrome` 的无边框最大化按钮检查会选择可用工作区小于整屏区域的显示器。若所有显示器的工作区都等于整屏，Qt 6.9 Windows 插件会在尺寸事件后把无边框最大化识别为全屏，该单个用例会明确跳过并说明原因；最小化、关闭、全屏、缩放边缘等检查继续执行。发布验证清单必须记录这个跳过项，不能把 CTest 可执行目标全部通过当作所有 Qt 用例均已执行。

`test_webengine_runtime_deployment` 检查缺少同步补丁运行库、版本或 SHA256 不匹配时配置必须失败。`test_webengine_startup` 除软件渲染参数检查外，还使用独立临时配置启动正常硬件加速窗口，确认 D3D11 合成启用且日志实际出现 `D3D11 fence sync: producer fence ready` 与 `consumer fence ready`（无 `fence sync disabled`）；再以 `TIGEREST_D3D11_FENCE_SYNC=0` 启动一次，确认回退路径出现 `D3D11 producer wait: completed=1, reset=0`。该测试不能代替媒体库悬停、滚动时的实际画面检查；不能因软件渲染测试通过就宣称花屏已修复。

`test_webengine_startup` 带 CTest 标签 `gpu-hardware`：它检查 D3D11 硬件合成。GitHub 托管的 Windows／macOS runner 没有 GPU，CI 用 `ctest -LE gpu-hardware` 排除它。首页、剧集、Jellyfin、Android 路由和首页缓存几项海报转场测试在软件渲染器上报告跳过（返回码 77）。这些测试都须在有 GPU 的机器上运行，CI 通过不代表它们已验证。
