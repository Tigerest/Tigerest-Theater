# 在 Windows 构建 Tigerest Theater

支持 Windows 10 1903+ 与 Windows 11 x64。

```cmd
dev\windows\setup.bat
dev\windows\build.bat
dev\windows\test.bat
dev\windows\bundle.bat
```

`setup.bat` 安装或下载 VS 2022 v143、CMake、Ninja、Inno Setup、Qt 6.9.3、AVX2/兼容版 libmpv 与 VC 运行库。构建结果位于 `build\src\Tigerest Theater.exe`；安装器和便携 ZIP 位于 `build\TigerestTheater-*.exe` / `build\TigerestTheater-*.zip`。

开发启动：

```cmd
dev\windows\run.bat
```

Windows 默认的原生 GPU-Next 模式使用 D3D11 绘制媒体库，MPV 在独立的原生子窗口中输出视频；媒体库保持硬件加速。显式选择 libmpv Render API 兼容模式时，Qt 界面使用它所需的 OpenGL 后端。切换渲染后端后须重启应用。

Windows/NVIDIA 媒体库花屏的共享纹理同步补丁及重建步骤见 [qtwebengine/README.md](qtwebengine/README.md)。使用修复组件开发时设置 `TIGEREST_WEBENGINE_RUNTIME`；已有构建目录通过同名 CMake 路径参数指定组件，打包会自动部署补丁版 WebEngine。

Windows 发布工作流会从 `v2.0.17-dev` 下载 `TigerestWebEngine-6.9.3-d3d11.zip`，校验固定 SHA256，再由打包脚本核验补丁及 DLL 清单。构建该版本的草稿时，工作流使用仓库令牌读取同一草稿中的运行库附件。后续版本继续使用这一固定组件，更新组件时应同时更新归档校验值、源码补丁与构建清单。归档只包含自建 WebEngine 组件、资源和重建说明，基础 Qt 仍为 6.9.3。

配置与日志按 profile 保存在 `%LOCALAPPDATA%\Tigerest Theater\profiles\<profile-id>\`。媒体库界面花屏时可尝试 `dev\windows\run.bat --disable-gpu`；这只关闭 QtWebEngine 网页的硬件加速，不更改 MPV 视频硬解或 Shader 设置。须完全退出应用后重新启动，已运行的实例不会应用新的启动参数。视频播放的图形兼容问题则可在设置中把渲染后端切换为 libmpv Render API 兼容模式。
