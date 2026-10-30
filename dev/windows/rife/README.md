# Windows RIFE 私有运行库（开发中）

这套工具生成独立于系统 Python、VapourSynth、CUDA Toolkit 和 SVP 的运行库。
主安装器不包含这些大型依赖。已接入 Windows Player 生命周期并可在原生验证程序里
实际播放。主程序启动、可信扩展安装及设置已接入；发行包、其他显卡和干净系统的
完整验收仍在进行，不能将本机验证视为所有设备均可达到性能目标。

## 固定依赖

`runtime-lock.json` 固定 Python 3.13.15 embeddable、VapourSynth R79、vs-mlrt v15.16
标准 TensorRT 10.16.0 / CUDA 13.2，以及外部模型包的 RIFE 4.25 lite、4.25、4.25 heavy。
Windows 默认选用 v2 导出、7 通道 FP16 输入输出和内部填充；坐标/除法层遵循上游 FP32 保护。
R80 能导入，但移除了 vstrt 所用的 API 3，实际加载失败，因此采用已验证的 R79。
没有使用 TensorRT-RTX 或其他推理后端。

模型归档来自 vs-mlrt 的 external-models 发布附件；该附件没有上游 SHA256，锁文件保存
从官方 HTTPS 下载计算出的哈希。它与 Mac 模型同名，尚未证明权重逐项等价。
运行库暂保留标准 TensorRT 的所有显卡架构资源；不把 4090 的结果推广到其他显卡。

## 开发准备与验证

在仓库根目录执行（只在开发阶段下载；不做全局安装）：

```powershell
python dev/windows/rife/prepare_runtime.py --output 'build/rife/私有 运行库 R79'
python dev/windows/rife/probe_runtime.py --runtime 'build/rife/私有 运行库 R79' --report build/rife/probe.json
$env:RIFE_TEST_RUNTIME=(Resolve-Path 'build/rife/私有 运行库 R79').Path
python -m unittest discover -s tests -p 'test_rife_runtime*.py' -v
python -m unittest discover -s tests -p test_rife_inference.py -v
```

已有官方归档时增加 `--archives DIR --offline`。输出目录必须尚不存在；下载哈希、归档
路径、文件清单全部通过后才将暂存目录原子移入输出位置。离线缺依赖不会退回系统安装。
7zr 26.03 是固定哈希的开发解压工具，用于读取 BCJ2；不进入运行库。

辅助进程使用私有解释器 `-B -I -S -X utf8` 和相对 `_pth`，禁用插件自动发现。
文件清单拒绝未知文件，辅助进程不在运行库里生成字节码或引擎。
DLL 审计只允许选定运行库、Windows 系统库和显式指定的 mpv；Windows Defender 的
MpOAV.dll 注入另行记录，要求路径属于注册的 WinDefend 服务并通过离线 Authenticode 验证。

真实推理测试以 256×128 的移动矩形和纹理验证中间帧与前后帧的差异。`frameRequestMs`
是整次请求耗时，包含转换、调度和拷贝，**不代表精确 GPU 推理时间**。
首次编译允许 15 分钟。上游 trtexec 在含中文的 timing-cache 路径上出现锁文件告警；
正式缓存由 `prepare_engine.py` 管理，直接构建静态引擎并避开上游 timing-cache 锁。
缓存只有在完整推理验证、大小/SHA256 和原子完成标记均通过后才可用于播放。
取消、15 分钟超时和 Windows Job 子进程树清理已经覆盖自动回归。

准备和滤镜阶段的可复现实测（路径由本机选择）：

```powershell
# request.json 只包含 runtime、cache、model、width、height，可选 deviceId/cancelFile/generation。
python dev/windows/rife/prepare_engine.py --request request.json --result ready.json
python dev/windows/rife/benchmark_filter.py --runtime RUNTIME --prepared ready.json --width 1920 --height 1080 --fps 24 --factor 10 --streams 2 --duration 15 --output filter.json
```

该工具明确排除解码、Shader 和渲染。`consumerFrameWaitP95Ms` 是消费者等待，
不作为 GPU 推理耗时；播放诊断中无精确 GPU 计时时返回 null。
三个目标及三模型的实测、测试范围和未通过项见 `docs/reports/2026-09-30-windows-rife.md`。

### 真实 Player 的 4K 输出测量

`rife_player_benchmark` 使用实际 Player、MpvVideoItem 工作线程、默认内置配置、
Shader 和音频，打开原生 3840×2160 窗口。它不包含 Emby/WebEngine 界面覆盖层。
测试在独立 profile 内运行，不改变系统显示模式；需要物理 4K 屏幕。

```powershell
python dev/windows/rife/benchmark_player.py --host build/tests/rife_player_benchmark.exe `
  --mpv VERIFIED_EOF_DLL --stats build/src/player/interpolation/tigerest-rife.dll `
  --qt-bin QT_BIN --runtime RUNTIME --cache CACHE `
  --monitor build/src/player/interpolation/tigerest-rife-vs.dll --media SDR_CFR_MEDIA `
  --model rife-4.25 --target 60 --seconds 600 --warmup 15 --output player.json
```

模型可选 `rife-4.25-lite`、`rife-4.25`、`rife-4.25-heavy`；目标 60/120/240
按 0.5 倍一档选择最接近目标的 1.5–15 倍倍率（距离相同取较低档）。例如
24→60 使用 2.5×，24000/1001→目标 60 输出 60000/1001；目标 0 保留 2×。
半整数倍率直接按输出时间点推理，最后一帧必要时缩短，保持原片总时长。
后端为 `gpu-next` 或 `libmpv`，Shader 预设为
`default`、`liveaction`、`aggressive`。媒体长度须覆盖预热、截图和完整采样。
`--baseline` 提供同配置原帧对照；引擎须已准备，否则此次保持原帧而不作为性能测量。

截图使用 mpv 的实际渲染窗口。截图时短暂暂停，恢复后排除 5 秒，再同时取
计数/媒体时间基线与采样时钟；JSON 保存实际 4K 尺寸、Shader、合成计数、缓存命中、
丢帧与音画偏差。每次生成独立 runId，写失败/旧文件/超时不能报告成功；内核 SHA
对应实际加载的 staged DLL。完整 JSON、PNG 和 `.json.native.log` 是本次证据。

退出码 0 或 `completed=true` 只表示采样完成。验收仍须检查完整时长、持续 Active、
真实合成、4K 输出和默认 Shader，稳态低于 1% 丢帧且音画偏差不持续超过 80ms。
`performanceFallback=true` 明确表示实际 guard 回退，不作为目标通过。

## mpv 内核

保留源版本 dd5d17d3285a095a0f712fa9d116e22a076492de 与 shinchiro 配方
cd1edc11dc6887a50f705717619d879f5a93a488。冻结的 FFmpeg、libplacebo 提交已匹配原 DLL
实际版本。共用 Mac EOF/颜色元数据补丁；另加 Windows EOF-aware 会话禁用插件自动加载的补丁。
`build_mpv.py` 检查来源与补丁适用性；实际交叉编译由 `build-rife-mpv.yml` 执行，必须先
构建 gcc，再构建 mpv。兼容 x86-64 和 AVX2 x86-64-v3 均须通过真实媒体验证。
`mpv-source-lock.json` 保存 CI 36761087304 成功冻结的源提交；CI 对原配方
验证该锁，不在每次构建重新解析移动分支。ngtcp2/curl 的 static OpenSSL
补丁保留原版本与功能，并修正压缩库的传递链接顺序。

普通 x64 的真实 EOF/色彩及 tiny TRT 流式测试已连续 10 轮通过，三模型的
默认 4K 输出均完成 600 秒长测。v3 候选先后暴露 Win64 GCC AVX 对齐崩溃；
hwdec 与 queue 的指针/局部副本补丁修复了两个位置，但 f9b11b1 候选仍在
无补帧的实际 4K 播放中崩溃，因此拒绝发行。两个 DLL 角色暂时都使用已验收的
普通 x64 内核，TensorRT GPU 加速保留。不得仅因短片测试或编译成功接受 v3。

2.9.5.1 起两个 DLL 角色都换成加了 `mpv-win32-precise-flip.patch` 的同一份普通 x64
内核（宿主源码 5122104，CI 40937947776，归档 `Tigerest-mpv-rife-x64-5122104.zip`
附在 v2.9.5.1 发行页；2.2.0–2.9.5 用的是 v2.2.0 附件里的 7a2b62d 内核）。
2026-10-30 在 RTX 4090、4K 240 Hz 上验收：真实 EOF/色彩及 tiny TRT 流式测试
连续 10 轮通过，Player 生命周期、mpv 早/晚激活、VSScript 和 TRT 帧图测试也都通过
（帧图测试的默认引擎路径不存在，需设 `RIFE_TEST_ENGINE_PATH`、
`RIFE_TEST_UNALIGNED_ENGINE_PATH` 指向 256×128 与 240×112 的 lite 引擎，并设
`RIFE_TEST_IMPLEMENTATION=2`）；1080p 23.976 fps 真实片源，三个模型各完成 600 秒默认 4K 输出
（2.5×、audio 同步、默认 3 个 Shader），全程 Active、0 掉帧、音画偏差最大 0.13 ms，
没有性能回退。翻页节奏在客户端里另测，见 `mpv-win32-precise-flip.patch` 的提交说明。

发布打包通过 `mpv-runtime-lock.json` 固定实际验收的内核 SHA、大小及 CI 来源，
不从开发机的 import library 目录恢复 stock DLL。准备独立目录后设置
`TIGEREST_MPV_RUNTIME_DIR` 再执行 `dev/windows/bundle.bat`：

```powershell
python dev/windows/rife/prepare_mpv_runtime.py --output build/rife-mpv-runtime
$env:TIGEREST_MPV_RUNTIME_DIR=(Resolve-Path build/rife-mpv-runtime).Path
```

默认从锁文件指定的发行页附件（当前为 v2.9.5.1）获取归档，并验证外层归档与每份 DLL 的大小、
SHA256 和构建来源。发行构建不依赖会到期的 Actions artifact；初次草稿构建需要
有权读取该草稿的 GitHub token。离线准备可加 `--archive 已下载的归档.zip`。

准备工具要求 `gh` 已登录可读取 CI 附件的账号；`--artifacts JSON` 支持本地已核验
产物目录映射。源和最终部署的两份 DLL 都必须符合锁文件，旧目标文件即使时间戳
相同也会重新复制、复核。Windows 打包要求 CMake 3.19+。
CI 复用旧媒体缓存前核对固定旧提交和所有依赖配方字节，命中后必须重建
mpv 并移除本次构建目录内旧 DLL 输出。不能用旧 DLL 填写新源码来源。

主程序的私有加载必须在 `mpv_create()` 前完成完整探测和激活，Windows mpv
会缓存环境变量。播放 Coordinator 只验证既有激活；新 native 加载测试验证
隔离 Python、中文路径、外部同名 DLL 拒绝及不写入 bytecode，不能替代真实
mpv 启动/EOF 集成验收。

## 发布前仍需完成

真实 Windows 媒体/EOF 测试需设置 `RIFE_TEST_RUNTIME` 和
`RIFE_TEST_EOF_MPV_DLL` 后重新配置 CMake；它调用独立 native host。
小尺寸 TRT 子项另需 `RIFE_TEST_STREAM_PREPARED` 指向完整的 256×128
prepare_engine 成功报告，CTest 自动提供 Monitor DLL 路径。现有 stock
DLL 不支持 eof-aware，会明确失败。显式 EOF gate 的上述 fixture 环境在
CMake 配置时保存，避免重新运行 CTest 时静默跳过已配置的真实用例。
滤镜吞吐工具支持 `--threads`、`--prefetch`，两项默认均为 4；它仍不测
解码、Shader、4K 渲染、音频和显示性能。

普通 x64 的真实 EOF、完整缓存和 Player 生命周期已验证；v3 修复产物、扩展安装/下载、
完整多场景性能和干净系统测试仍需验收。
许可证文本已开始收集（Python/VS 在各自包中；vs-mlrt GPLv3、Practical-RIFE MIT、
TensorRT SLA 在 licenses 中）。公开分发前还需补齐 CUDA/VC 运行库通知与准确的对应源代码，
并核实组合分发条款。当前实验运行库不得当作完成版权材料的发行附件。

## 扩展包开发工具

package_extension.py把已封存runtime、实际playback脚本/Monitor及notices生成ZIP64，
不带引擎/用户设置。固定catalog记录外层SHA256、manifestSha256、版本范围、ABI、
下载/展开大小和文件数。正式版目录使用已发布的固定 GitHub 附件。verify_extension.py 是
参考校验器，不安装或执行内容。原生管理层实现磁盘预算、取消、原子 active、
多进程使用锁、启动全量再校验和强 ETag 续传；客户端提供下载、离线 ZIP 导入及卸载。
发行验收记录见 docs/reports/2026-09-30-windows-rife.md。

版本区间为 minAppVersion（含）至 maxAppVersion（不含）。已封存的扩展可通过可信目录
compatibleAppVersions 数组显式批准额外的应用版本；该数组只列确定已验证的版本，
不会改变原 ZIP、清单版本范围、SHA256 或 ABI 校验。新增应用版本必须更新目录并运行
实际目录／应用版本回归，不能修改封存包的清单身份。

回归实际构造原始local/central ZIP头，验证NUL/反斜杠未被zipfile规范化后隐藏；
路径穿越、Windows保留名、Unix链接/DOS目录/重解析位、重复大小写路径、父文件冲突、
尺寸/身份/哈希、变化源文件、合法已有输出和发布竞争均拒绝。发布使用同卷原子
hardlink，不覆盖另一发布者，失败只清理自己的单个临时文件。

原生ZIP64使用固定miniz3.1.2读取器，Qt进行Unicode文件I/O，并在写文件前比较完整
local/central原始名字。安装至独立暂存目录，完整逐文件SHA/CRC通过后发布版本目录，
active.json原子提交；正在使用的版本持有跨进程lease，卸载等退出后清理。再导入会撤销
该版本的待卸载记录；已返回运行路径后拒绝同进程重新initialize，避免热切换DLL。

下载使用独立QNAM，不传Emby鉴权。只接受可信目录的HTTPS；206要求完整Content-Range
和同一强ETag，200重新写入，弱ETag不续传，完整SHA通过才安装。取消缓存复验保留已
下载的文件。测试使用公开loopback TLS fixture及独立HTTP listener，不改变系统信任。
状态与操作通过 QWebChannel 暴露给客户端设置；打开设置不会自动开始下载。
