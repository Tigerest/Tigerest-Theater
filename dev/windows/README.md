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

配置与日志按 profile 保存在 `%LOCALAPPDATA%\Tigerest Theater\profiles\<profile-id>\`。出现图形兼容问题时可尝试 `dev\windows\run.bat --software-rendering`，或在设置中把渲染后端切换为 libmpv Render API 兼容模式。
