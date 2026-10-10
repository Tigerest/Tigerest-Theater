# QtWebEngine 6.9.3 的 Windows D3D11 同步补丁

部分 Windows/NVIDIA 配置在媒体库悬停、滚动和显示设置面板时出现旧画面闪回和三角形缺块。独立 Qt Quick/WebEngine 静态页面也可复现，Qt 提交显示之前的抓帧已包含错误。补丁在 Chromium producer 的 D3D11 设备完成写入后，才把共享纹理交给 Qt 的另一个 D3D11 设备读取。

作用域是 `NativeSkiaOutputDeviceDirect3D11::Present` 的 GL/ANGLE producer 路径，不持有基类缓冲区锁等待。使用 EVENT query 的 `End/Flush/GetData`，确认 `S_OK`、完成标志和设备状态。250 ms 轮询截止后不发布该纹理，通过 `SWAP_FAILED` 走 Chromium 原有 context-loss 恢复。此截止不能中断卡在驱动 API 内的调用。

默认启用；设置 `TIGEREST_D3D11_PRODUCER_WAIT=0` 可做关闭对照。`TIGEREST_DIAG_PRODUCER_FAIL_ONCE=1` 仅用于测试：第八次提交模拟未完成，等待至截止并注入一次恢复。普通启动不设置这些变量。原先公共 `createFence()` 内的无限等待诊断不属于此补丁。

## 重建组件

上游来源：[Qt 6.9.3 源码存档](https://download.qt.io/archive/qt/6.9/6.9.3/submodules/qtwebengine-everywhere-src-6.9.3.tar.xz)。归档 SHA256：

```
d50b3b11d51dd876418cc36b4d6c96b4721e0aab773a3dd6beda606d46da8966
```

在已初始化的 VS 2022 x64 开发环境运行，需具备 x64/x86 编译工具、ATL 和 Windows SDK。实测工具为 MSVC 14.44.35207、SDK 10.0.26100.0、Python 3.12.10（含 html5lib）、Node 24、CMake/Ninja，以及 bison/flex/gperf/perl。参见 [Qt WebEngine 平台与构建说明](https://doc.qt.io/qt-6/qtwebengine-platform-notes.html)。使用较短的 ASCII 构建路径，源码、构建和安装目录分开。

```powershell
./dev/windows/qtwebengine/build.ps1 `
  -SourceDirectory C:/QtBuild/webengine-src `
  -BuildDirectory C:/QtBuild/webengine-build `
  -QtRoot C:/Qt/6.9.3/msvc2022_64 `
  -InstallDirectory C:/QtBuild/webengine-runtime `
  -PythonExecutable C:/QtBuild/tools/Scripts/python.exe -Jobs 8
```

脚本应用本目录补丁，编译 Release 组件，安装到独立目录，并记录补丁和 DLL 的 SHA256。首次完整编译 Chromium 耗时较长。

## 客户端开发与打包

开发启动前设置 `TIGEREST_WEBENGINE_RUNTIME` 为上述组件安装目录，再运行 `dev/windows/run.bat`。Qt 基础组件仍使用同版本的 MSVC 版 Qt 6.9.3。

已有 CMake 构建目录需明确更新缓存：

```powershell
cmake -S . -B build -DTIGEREST_WEBENGINE_RUNTIME=C:/QtBuild/webengine-runtime
cmake --build build
```

Windows 打包在 `windeployqt` 完成后覆盖 WebEngine DLL、辅助进程、资源和 QML 模块，防止打包时恢复为上游 DLL。补丁和本文随包保存于 `licenses/qtwebengine-tigerest`。无需把 Qt 完整源码或编译中间文件放入客户端安装目录。

修复运行库是 Windows 构建和打包的必需依赖。`build.bat` 自动查找依赖目录下的 `qtwebengine-sync/6.9.3`，也可显式设置 `TIGEREST_WEBENGINE_RUNTIME`。配置和安装阶段均校验版本、完整文件、源码补丁及核心 DLL 的 SHA256；路径为空或验证失败时停止，不能退回原版 QtWebEngine。安装后再次校验实际部署的核心 DLL，避免旧缓存或文件时间戳使修复失效。

## 回归证据

2026-09-13，Windows 11 23H2 / RTX 4090 / 驱动 616.64：相同 DLL 关闭等待可重复捕获缺块，开启有界等待后十轮、每轮约十二秒的鼠标悬停测试未捕获加载完成后的固定内容区异常。模拟超时触发恢复后继续产生有效画面并响应鼠标。此前无限等待诊断的开关对照及用户手动反馈也支持此同步措施有效。

最终客户端已通过全部 14 项 CTest；实际验证媒体库先全屏再播放时，uosc 正确显示退出全屏，鼠标单击即可窗口化，mpv 与宿主窗口状态均为 false。模拟超时恢复后的独立测试程序正常退出，退出码为 0。安装目录中的客户端使用原有配置启动，确认加载补丁 DLL、D3D11 硬件合成和光栅化均启用，默认同步日志正常。

手动覆盖旧安装时，还需把本次构建的 `redist/*.dll` 更新到程序目录，避免残留的旧版应用私有 VC++ 运行库优先于系统新版加载。此次旧版 14.29 的 `MSVCP140.dll` 导致启动访问冲突，替换为随包的 14.44 后正常。便携包准备脚本已包含将这些 DLL 放入根目录的步骤。

这些结果覆盖该受影响配置，不代表已验证所有 GPU、驱动或完整缓冲区复用协议。固定区域哈希与抽样画面检查也不能覆盖所有帧和全部像素。

2026-10-10，2.5.3 用户报告媒体夹海报墙仍偶发花屏。安装 EXE 与发行包一致，核心 DLL 仍为上面的已验证补丁，日志正常；因此不能归因于补丁漏打包，也不能把旧结果当作本次修复证据。补丁只保证 producer 写入完成，没有完整证明 consumer 读取与纹理复用的协议。后续版本须执行 [Windows 每次更新必检](../RELEASE_CHECKLIST.md)，以实际窗口像素和真实媒体库操作结果为准。
