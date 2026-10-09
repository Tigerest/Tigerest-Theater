# 应用内更新下载续传

状态：桌面与 Android 更新器均已改为续传，两端单元测试均在 Linux 上通过；尚未在 Windows、Mac 或 Android 设备上构建验证，也未实际下载验证。

## 问题

Windows 2.4.4 升级 2.5.0 时提示"更新未完成"。版本检查和 GitHub 跳转都成功，失败发生在下载 244 MB 安装包的途中。

诊断程序日志显示：下载到 10%～20% 后 30 秒没有数据，Qt 的 `setTransferTimeout(30000)` 中止请求，得到 `OperationCanceledError`（HTTP 200）。旧更新器随后报"无法获取更新"，并删除 `.part`，进度归零。按这种频率断流，重试多少次都无法下载完成。

诊断中，使用已安装运行库（Schannel）的 3 次运行都中断，使用开发环境运行库（OpenSSL）的 2 次都完成；两组还使用了不同的 Qt 库目录，且先后运行，不能确认 TLS 后端就是原因。这次修复不更换 TLS 后端。

另一个隐患：旧代码给下载设了 30 分钟总时限，平均速度低于约 136 KB/s 时，不断流也会失败。

Android 更新器（`AppUpdateEngine.kt`）在任何下载失败或取消时同样删除 `.part`，启动时也会清空，因此同样无法续传。

## 桌面修改（`src/system/AppUpdater.cpp`）

- 部分下载按可信 SHA-256 存在 `updates/<sha256>/<文件名>.part`，失败、取消和退出时都保留，重启后仍可继续。
- 每次尝试都从正式发布地址重新走跳转（签名链接会过期），已有进度时发送 `Range: bytes=<已下载>-`。只有 `Content-Range` 精确匹配的 206 才接着写入；200 从头覆盖；416 或范围不符时清空后重下。
- 断流、5xx、403、408、429 自动重试，默认间隔 2/5/10/20/30 秒。收到新数据会重置次数，连续 5 次重试都没有收到新数据才报错，并提示进度已保留。404 等其他客户端错误直接报错，不重试。
- 去掉下载的 30 分钟总时限，只靠 30 秒无数据判断断流。版本检查仍保留 30 秒总时限。
- 下载阶段和版本检查阶段的错误提示分开。重试期间界面显示"下载中断，N 秒后自动继续"和"正在重新连接"。
- SHA-256 校验失败或跳过版本时删除部分文件。下载其他版本时，清理旧版本残留的 `.part`，已校验的安装包不动。缓存中已有校验通过的同版本安装包时直接复用。

## Android 修改

- 部分下载改名为 `update-<sha256>.part`，取消、失败和重启后保留；启动只清理旧的编号文件。SHA-256 或 APK 身份校验失败、跳过版本时删除。
- 响应处理移入只依赖 OkHttp 的 `AppUpdateTransfer.kt`：规则与桌面一致，206 须精确衔接，200 覆盖，416 或范围不符清空后抛出可续传错误；数据提前结束也视为可续传。
- `AndroidAppUpdateSource` 每次从正式发布地址开始，跳转的每一跳都带 `Range`；下载时的 403、408、429、5xx 视为可续传，版本检查的错误处理不变。
- `AppUpdateEngine` 在后台线程按同样的间隔自动重试，等待期间每 100 毫秒检查是否已取消，界面提示与桌面相同。
- 设备验收脚本 `android/tests/test_app_update.cjs` 的本机夹具改为支持 Range，并断言"取消后再次下载"发出了续传请求。

## 验证

- 桌面：Ubuntu 24.04 + Qt 6.4.2，单独编译 `test_appupdater` 和 `test_appupdate_policy`：16/16 与 18/18 通过，连续运行 3 次结果一致。新增 6 项测试覆盖断流续传及跳转地址、服务器忽略 Range、`Content-Range` 不符、多次失败保留进度、404 不重试、重启与取消后续传、跳过时删除部分文件。用旧实现运行同一测试文件，6 项新测试全部失败，原有 10 项通过。
- Android：本机无法下载 Android SDK，未运行 Gradle Android 构建、`testDebugUnitTest` 或 Lint。改为在独立 Kotlin 2.2.21 JVM 工程中编译 `AppUpdateEngine.kt`、`AppUpdatePolicy.kt`、`AppUpdateTransfer.kt` 及其测试：`AppUpdateEngineTest` 13/13、`AppUpdatePolicyTest` 4/4、`AppUpdateTransferTest` 6/6 通过。用旧引擎运行时，3 项新增测试和修改断言的取消测试失败，其余 9 项通过。`AndroidAppUpdateSource.kt` 依赖 Android API，未经编译。设备夹具的 Range 处理在本机用 Node 单独验证（完整、续传、越界请求，快慢两种模式），整段设备验收未运行。
- 以上均为测试夹具验证，网络回复由测试替换。正式版桌面使用 Qt 6.9.3，尚未在 Windows 运行 CTest；未验证 GitHub 生产附件的实际续传，也未在 Qt WebEngine 或 Android WebView 中查看重试提示。

## 发布说明

2.4.2～2.5.0 客户端仍使用旧更新器，断流会清零，无法获得续传。发布含此修复的版本时，发布说明应请这些用户手动下载安装包升级一次（已写入 `CHANGELOG.md` 的"未发布"部分与 README）。
