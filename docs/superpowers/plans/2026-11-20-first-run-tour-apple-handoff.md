# 首次使用引导：交给 Mac 那边（iPhone / iPad、Apple TV、Mac 的 Qt 版）

日期：2026-11-20（Asia/Shanghai）

## 1. 分支和基线

| 项 | 内容 |
| --- | --- |
| 分支 | `claude/first-run-tour`，在 Windows 电脑上提交，还没推送 |
| 基线 | `origin/main` 的 `eacd1b4`（3.0.0 之后） |
| 设计文档 | [docs/superpowers/specs/2026-11-20-first-run-tour-design.md](../specs/2026-11-20-first-run-tour-design.md)，步骤和文案以它为准 |
| 版本号 | 没有改动 |

## 2. 已经做好的部分（所有平台共用）

| 文件 | 作用 |
| --- | --- |
| `native/onboardingTour.js` | 引导本身：遮罩只亮出讲解的部分，旁边是气泡（粗体标题、两三行说明、「2 / 14」、上一步／下一步、右上角 ×）。不依赖第三方库，离线可用，跟随深浅色 |
| `native/nativeshell.js` | 「客户端 → 客户端设置」加「重新打开引导」（只在加载了引导脚本时出现）；`tigerestClientMenuBack()` 先交给引导 |
| `native/inputPlugin.js` | 引导打开时，遥控器、手柄和 CEC 的按键先交给引导 |
| `resources/settings/settings_description.json` | 隐藏设置 `main.onboardingTour`，默认空字符串 |
| `src/settings/SettingsComponent.cpp`、`src/system/SystemComponent.cpp` | Qt 版判断新老用户，并注入脚本（Mac 的 Qt 版自动带上） |
| `android/.../SettingsStore.kt`、`WebHost.kt` | Android 判断新老用户，并注入脚本 |
| `tests/test_onboarding_tour_ui.cjs` | CTest `test_onboarding_tour_webengine`；`TIGEREST_ANDROID_FIXTURE=1` 时也能在 Android 夹具上跑（跳过 Qt 才有的第 1 部分） |

`main.onboardingTour` 的取值，各平台必须一致：

| 值 | 含义 |
| --- | --- |
| `new` | 新装或新建配置档：进首页自动开始，**不能跳过**（没有 ×，第一张卡只有「开始」，Esc／返回键退回上一步） |
| `upgrade` | 从旧版本升级：自动开始，可以跳过 |
| 空字符串 | 平台没判断出来，按 `upgrade` 处理 |
| `replay` | 用户点了「重新打开引导」：可以跳过 |
| `done` / `skipped` | 走完／跳过，不再自动出现 |
| `off` | 测试用，永不自动出现，「重新打开引导」照常能用 |

中途被打断（开始播放、离开首页或作品页）时不写状态，下次回到首页重新开始；新用户中断后仍然不能跳过。

## 3. Mac 的 Qt 版：只需编译和验证

代码和 Windows 是同一份，不用改。Mac 上的区别由脚本自己判断：

- 第 9 步快捷键写成 ⌘, 和 ⌘O；
- 补帧一步叫「补帧」，`api.player.mpvDiagnostics()` 返回 `rife` 或 `native` 时才出现，不提 RTX 和 VFG。

要做的：

1. 编译后跑 `test_onboarding_tour_webengine` 和整套 CTest。测试夹具默认写入 `off`，其他测试不会被引导挡住。
2. 用隔离配置档连真实服务器走一遍，逐步截图。
3. 核对两处文案：
   - 专业模式那步写的是「播放时按 F2」。Mac 键盘可能要按 fn+F2，需要的话改成「fn+F2」或只写面板图标。
   - 「窗口与全屏」一步亮出的是首页左上的窗口按钮。

## 4. iPhone / iPad：四处小改

### 4.1 同步清单

`apple/tools/sync_resources.py` 的 `SCRIPTS` 在 `homeMotion` 后面加 `onboardingTour`。顺序和桌面、Android 保持一致：homeMotion → onboardingTour → embycompat。

### 4.2 `apple/App/SettingsStore.swift`

**这一处必须和 4.1 同一次提交。** 现在 `values` 已经带着描述文件里这个隐藏项的默认值（空字符串），`WebHost` 又把 `values` 原样交给 `jmpInfo.settings`。如果只同步了脚本而没改这里：

- 引导会按升级用户自动开始；
- 结束时写 `done` 会被 `set` 以 `invalidSetting` 拒绝；
- 结果是每次启动都会再弹一次。

要改两处：

1. `supported["main"]` 加 `"onboardingTour"`。
2. 在 `init` 里恢复完已保存的值之后，判断新老用户。第 107 行的 `saved` 是在 shaderPreset 迁移写文件之前读的，所以 `saved == nil` 就是新装或新配置档：

   ```swift
   // The first-run usage tour cannot be skipped on a new install or profile;
   // settings an earlier version saved belong to an upgraded user.
   if saved?["main"]?["onboardingTour"] == nil {
       values["main"]?["onboardingTour"] = .string(saved == nil ? "new" : "upgrade")
       try JSONEncoder().encode(values).write(to: file, options: .atomic)
   }
   ```

   这段要放在 shaderPreset 迁移那段的后面，或者和那次写文件合并，保证迁移写文件不会把 `saved == nil` 的判断提前改掉。

### 4.3 测试开关

`--ui-testing` 下默认把这个值设成 `off`，用启动参数覆盖：

```swift
// UI tests keep the usage tour off unless one asks for it (-TigerestOnboardingTour new).
if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
    values["main"]?["onboardingTour"] = .string(UserDefaults.standard.string(forKey: "TigerestOnboardingTour") ?? "off")
}
```

这样现有的 `WebHostTests` 不用改。新的引导测试传 `-TigerestOnboardingTour new` 或 `upgrade`，写法和现有的 `-TigerestPlaybackGesturesSeen YES` 一样。

### 4.4 真机核对

脚本靠 `window.tigerestIPadApi` 或 `api.system.isIPad` 认出 iOS，按触屏处理：

- 欢迎卡写「随时可以点 × 退出」；
- 客户端菜单一步多写「下载与离线媒体」；
- 播放器一步只讲手势。

要核对的几处：

1. **手势文案。** 现在写的是：「第一次播放时会先教你手势：双击暂停，横着滑快进快退，左右两侧上下滑调亮度和音量，长按画面临时两倍速。」对照 `PlayerView.swift` 的「播放手势」说明（左侧亮度、右侧音量、长按 2×），目前一致。如果想提播放器里的「手势教程」按钮，就在 `buildSteps()` 的 iOS 分支加一句。
2. **补帧一步。** 只看 `jmpInfo.capabilities.rife`，也就是只有 `RIFE_NATIVE` 的构建才出现。只有 Apple 原生补帧（`NATIVE_VTFI`）的构建如果也要这一步，有两处要改：
   - `WebHost` 的 capabilities 加一个标志，比如 `nativeInterpolation`；
   - `environment()` 里 iOS 那行改成 `caps.rife || caps.nativeInterpolation`。
3. **返回手势。** iPhone/iPad 左边缘右滑走的是 `WebHost.backScript`，它先调 `tigerestClientMenuBack()`，引导已经接在那里。效果：
   - 升级用户和重新打开的引导：关闭引导；
   - 新用户：退回上一步。
4. **位置。** iPhone 竖屏宽度小于 600px，气泡贴在屏幕上方或下方，并让开 `--tgs-safe-*` 留出的安全区；iPad 横屏时气泡放在目标旁边。两种都要截图确认。顶栏把「一起看」收进「⋯」时，说明会改成「在顶栏「⋯」里的「一起看」输入」。
5. **测试。** 新建一个 UI 测试，用 `-TigerestOnboardingTour new` 启动，然后检查：
   - 走完全部步骤；
   - 关掉 App 再打开不再出现；
   - 用 `upgrade` 启动时可以按 × 跳过。

## 5. Apple TV：原生 SwiftUI 引导

Apple TV 没有网页，要用 SwiftUI 另写一个外观相同的引导。步骤见设计文档第六节「Apple TV」，共 8 步。下面是实现要点。

### 5.1 外观

和网页版一致，只用深色：

| 部分 | 颜色 |
| --- | --- |
| 遮罩 | `rgba(6,7,10,.66)` |
| 气泡底色 | `rgba(24,23,21,.98)` |
| 气泡边框 | `rgba(239,195,110,.32)` |
| 标题文字 | `#f1ece3` |
| 说明文字 | `#d6cfc2` |
| 计数 | `#a39b8d` |
| 主按钮 | 底色 `#efc36e`，文字 `#1d1912` |
| 亮出区域的描边 | `#efc36e` |

亮出区域用 `anchorPreference` 收集目标的 bounds，在遮罩上挖洞。目标按下面的 `accessibilityIdentifier` 找。

### 5.2 状态

存在 `UserDefaults` 的 `tv.onboardingTour`，取值同第 2 节。

- **新老用户：** 这个版本第一次启动时，满足任一条件就记 `upgrade`，否则记 `new`：
  - `TVSessionStore` 里有登录记录；
  - 已经存在 `tv.home.displayOrder`、`tv.library.sort` 或 `tv.qualityPreset`。
- **测试：** `--tv-fixture` 下默认 `off`，`-TigerestOnboardingTour <值>` 可以覆盖。和 `tv.home.displayOrder` 一样，`fixtureMode` 时只存在内存里，不写进 `UserDefaults.standard`。

### 5.3 何时开始

登录后回到首页、媒体库加载完、焦点稳定约 1 秒时开始。

开始播放或跳到别的页面时，引导结束但不写状态，下次回到首页重新开始。

### 5.4 遥控器

| 按键 | 作用 |
| --- | --- |
| 左右（`onMoveCommand`） | 切换步骤 |
| 触控板按下 | 按下聚焦的按钮 |
| Menu／返回（`onExitCommand`） | 升级用户和重新打开的引导：关闭，记 `skipped`；新用户：退回上一步，第一步什么也不做 |

新用户的第一张卡只有「开始」。其他情况第一张卡是「跳过／开始」。tvOS 上 × 不好聚焦，可以不做，用「跳过」和 Menu 键代替。

### 5.5 各步的目标

| # | 目标 | 说明 |
| --- | --- | --- |
| 2 | 顶栏：「服务器」「播放设置」`tv.quality`、「刷新」`tv.refresh`、「退出登录」`tv.logout` | 「服务器」按钮（`TVRootView.swift` 第 72 行）现在没有标识，做的时候补一个 `tv.servers`。亮出整行按钮的合并范围 |
| 3 | 媒体库一列 `tv.library.<id>` | 合并所有媒体库按钮的范围 |
| 4 | `tv.home.hero` | |
| 5 | `tv.home.order` 和 `tv.home.more` | |
| 8 | `tv.quality` | |

第 1、6、7 步居中，不亮出任何东西。哪个目标不存在（比如没有作品时没有 `tv.home.hero`），就跳过那一步并重算总步数。

### 5.6 重看入口

在「播放设置」（`TVPlaybackSettings`）底部加「重新打开引导」：

1. 写 `replay`；
2. 关闭设置，回到首页开始。

### 5.7 测试

在 `TVUITests` 里用 `XCUIRemote` 写两个测试：

- **新用户：** 用 `-TigerestOnboardingTour new` 启动，走完 8 步；检查计数、Menu 退回上一步；重启后不再出现。
- **升级用户：** 用 `upgrade` 启动，按 Menu 关闭，检查状态是 `skipped`。

## 6. 这台电脑上的测试情况

截至交接时：

- **Windows：** `test_onboarding_tour_webengine` 通过（夹具页面，不是真实服务器）。整套 CTest 和真实客户端走查的结果见这个分支的提交说明。
- **Android：** 编译、166 个单元测试（2 个跳过）、lint 都通过。测试手机上的走查还没做。
