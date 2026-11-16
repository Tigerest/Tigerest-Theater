import QtQuick
import Konvergo 1.0
import QtWebEngine
import QtWebChannel
import QtQuick.Window
import QtQuick.Controls
// WebEngine loads ControlsDelegates/FilePicker.qml dynamically. Keep this
// import explicit so deployment includes its QtQuick.Dialogs runtime.
import QtQuick.Dialogs
import Qt.labs.platform as Labs

Window
{
  id: mainWindow
  readonly property bool automatedTestWindow: {
    const args = Qt.application.arguments
    const profile = args.indexOf("--profile")
    return profile >= 0 && (args[profile + 1] === "Mac120HzProductionProbe" ||
                            args[profile + 1] === "MessagesFixture")
  }
  title: automatedTestWindow ? "大河影院 · 自动测试（临时窗口）" : "Tigerest Theater / 大河影院"
  objectName: "mainWindow"
  width: 1280
  height: 720
  minimumWidth: 213
  minimumHeight: 120
  visible: true
  color: "#000000"
  readonly property bool customTitleBarEnabled: components.system.isWindows
  flags: customTitleBarEnabled ? Qt.Window | Qt.FramelessWindowHint |
                                Qt.WindowSystemMenuHint | Qt.WindowMinimizeButtonHint |
                                Qt.WindowMaximizeButtonHint | Qt.WindowCloseButtonHint : Qt.Window
  readonly property int chromeHeight: windowChrome.barHeight

  WindowChrome {
    id: windowChrome
    objectName: "windowChrome"
    hostWindow: mainWindow
    videoActive: mainWindow.nativeVideoVisible
    enabled: mainWindow.customTitleBarEnabled
    anchors.fill: parent
    z: 1000
  }

  // Properties previously from KonvergoWindow
  property bool webDesktopMode: true
  property bool showDebugLayer: false
  property string debugInfo: ""
  property string videoInfo: ""
  property string webUrl: ""
  property bool startupCoverVisible: true
  // Keep WebEngine composited underneath the native GPU-Next host. Recreating
  // its scene texture after playback caused stale/duplicated library frames on
  // Windows. The libmpv Render API shares this QML scene, so its compatibility
  // path still hides WebEngine while the video item is active.
  property bool nativeVideoVisible: false
  property bool useUoscPlaybackUi: components.settings.value("mpv", "enableUosc")

  property bool showSystemTrayIcon: webDesktopMode && components.system.isWindows &&
                                    components.settings.windowsTrayIcon

  signal reloadWebClient()

  Component.onCompleted: {
    if (components && components.settings) {
      webUrl = components.settings.getWebClientUrl(webDesktopMode)
    }
  }

  onClosing: function(close) {
    if (showSystemTrayIcon) {
      // Minimize to tray on close.
      close.accepted = false
      mainWindow.hide()
    } else if (components.system.isWindows) {
      // An accepted close destroys the host HWND before mpv can release its VO.
      close.accepted = false
      components.system.exit()
    }
  }

  function toggleFullscreen() {
    components.window.setFullScreen(!components.window.isFullScreen())
  }

  function toggleDebug() {
    showDebugLayer = !showDebugLayer
  }

  function setFullScreen(enable) {
    components.window.setFullScreen(enable)
  }

  function minimizeWindow() {
    if (visibility !== Window.FullScreen)
      visibility = Window.Minimized
  }

  function restoreWindow() {
    mainWindow.show()
    mainWindow.raise()
    mainWindow.requestActivate()
  }

  function runWebAction(action)
  {
    if (mainWindow.webDesktopMode)
      web.triggerWebAction(action)
  }

  Action
  {
    enabled: mainWindow.webDesktopMode
    shortcut:
    {
      if (components.system.isMacos) return "Ctrl+Meta+F"
      return "F11"
    }
    onTriggered: mainWindow.toggleFullscreen()
  }

  Action
  {
    shortcut: "Alt+Return"
    enabled:
    {
      if (mainWindow.webDesktopMode && components.system.isWindows)
        return true;
      return false;
    }
    onTriggered: mainWindow.toggleFullscreen()
  }

  Action
  {
    enabled: mainWindow.webDesktopMode
    shortcut: StandardKey.Close
    onTriggered: mainWindow.close()
  }

  Action
  {
    enabled: mainWindow.webDesktopMode
    shortcut: {
      if (components.system.isMacos) return "Ctrl+M";
      return "Meta+Down";
    }
    onTriggered: mainWindow.minimizeWindow()
  }

  Action
  {
    enabled: components.system.isWindows
    shortcut: "Alt+F4"
    onTriggered: components.system.exit()
  }

  Action
  {
    enabled: mainWindow.webDesktopMode
    shortcut: components.system.isWindows ? "Ctrl+Q" : StandardKey.Quit
    onTriggered: components.system.exit()
  }

  Action
  {
    shortcut: "Ctrl+Shift+D"
    enabled: mainWindow.webDesktopMode
    onTriggered: mainWindow.toggleDebug()
  }

  // The page's editing and history keys, only while the page takes input. A
  // window shortcut takes the key press before the focused item sees it, so
  // while uosc owns playback these stayed with the disabled page: Ctrl+V never
  // reached uosc's search box and mpv saw the key release alone.
  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Copy
    onTriggered: runWebAction(WebEngineView.Copy)
    id: action_copy
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Cut
    onTriggered: runWebAction(WebEngineView.Cut)
    id: action_cut
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Paste
    onTriggered: runWebAction(WebEngineView.Paste)
    id: action_paste
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.SelectAll
    onTriggered: runWebAction(WebEngineView.SelectAll)
    id: action_selectall
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Undo
    onTriggered: runWebAction(WebEngineView.Undo)
    id: action_undo
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Redo
    onTriggered: runWebAction(WebEngineView.Redo)
    id: action_redo
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Back
    onTriggered: runWebAction(WebEngineView.Back)
    id: action_back
  }

  Action
  {
    enabled: web.enabled
    shortcut: StandardKey.Forward
    onTriggered: runWebAction(WebEngineView.Forward)
    id: action_forward
  }

  Action
  {
    enabled: mainWindow.webDesktopMode
    shortcut: "Ctrl+0"
    onTriggered: web.zoomFactor = 1.0
  }

  WebChannel
  {
    id: webChannelObject
  }

  Binding
  {
    target: web
    property: "zoomFactor"
    value: 1.0
    when: !components.settings.allowBrowserZoom()
  }

  Timer
  {
    id: startupCoverTimer
    interval: 500
    repeat: false
    onTriggered: mainWindow.startupCoverVisible = false
  }

  Connections
  {
    target: components.player
    function onWindowVisible(visible)
    {
      mainWindow.nativeVideoVisible = visible
      if (visible && mainWindow.useUoscPlaybackUi) {
        // libmpv and uosc own input while the continuously composited Emby page
        // remains ready underneath the native video host.
        video.forceActiveFocus()
      } else {
        web.forceActiveFocus()
      }
    }
  }

  MpvVideoItem
  {
    id: video
    objectName: "video"
    visible: mainWindow.nativeVideoVisible
    enabled: mainWindow.nativeVideoVisible && mainWindow.useUoscPlaybackUi
    z: 200
    focus: mainWindow.nativeVideoVisible && mainWindow.useUoscPlaybackUi

    onFullscreenRequested: function(fullscreen) {
      // MPV reports its initial fullscreen=false before any video is shown.
      // Hidden playback must not override the library's startup preference.
      if (mainWindow.nativeVideoVisible)
        components.window.setFullScreen(fullscreen)
    }

    // Keep native GPU-Next's child HWND clear of the QML resize handles.
    width: mainWindow.contentItem.width - windowChrome.resizeInset * 2
    height: mainWindow.contentItem.height - mainWindow.chromeHeight - windowChrome.resizeInset
    anchors.left: mainWindow.contentItem.left
    anchors.right: mainWindow.contentItem.right
    anchors.leftMargin: windowChrome.resizeInset
    anchors.rightMargin: windowChrome.resizeInset
    anchors.top: mainWindow.contentItem.top
    anchors.topMargin: mainWindow.chromeHeight

    Component.onCompleted: {
      console.log("MpvVideoItem size:", width, "x", height, "visible:", visible)
    }
    onWidthChanged: console.log("MpvVideoItem width changed:", width)
    onHeightChanged: console.log("MpvVideoItem height changed:", height)
  }

  WebEngineView
  {
    id: web
    objectName: "web"
    width: mainWindow.width
    y: mainWindow.chromeHeight
    height: mainWindow.height - mainWindow.chromeHeight
    z: 100
    visible: video.nativeGpuNext || !mainWindow.nativeVideoVisible || !mainWindow.useUoscPlaybackUi
    enabled: !mainWindow.nativeVideoVisible || !mainWindow.useUoscPlaybackUi
    backgroundColor: "transparent"

    webChannel: webChannelObject
    settings.errorPageEnabled: false
    settings.localContentCanAccessRemoteUrls: true
    settings.localContentCanAccessFileUrls: true
    settings.allowRunningInsecureContent: true
    settings.playbackRequiresUserGesture: false
    profile.httpUserAgent: components.system.getUserAgent()
    profile.httpCacheType: WebEngineProfile.DiskHttpCache
    url: mainWindow.webUrl
    focus: true
    property string currentHoveredUrl: ""
    property var serverSelection: null
    function rollbackServerSelection() {
      const pending = serverSelection;
      if (!pending) return;
      serverSelection = null;
      components.settings.setValue("main", "userWebClient", pending.previousAddress);
      components.settings.setValue("main", "serverConnectionMode", pending.previousMode);
      // With error pages disabled, failures before commit leave the chooser
      // document in place. Unlock it rather than going back past it.
      components.system.markServerSelectionError();
      web.stop();
      web.runJavaScript("Boolean(window.tigerestServerSelectionFailed?.())", function(handled) {
        if (handled) components.system.takeServerSelectionError();
        else web.goBack();
      });
    }
    onLinkHovered: function(hoveredUrl)
    {
      web.currentHoveredUrl = hoveredUrl;
    }
    profile.persistentCookiesPolicy: WebEngineProfile.AllowPersistentCookies
    profile.offTheRecord: false
    profile.storageName: "TigerestTheaterStorage"

    Component.onCompleted:
    {
      // The QML setting was added in Qt 6.8. Older Linux runtimes must still
      // parse this view; newer runtimes opt into animated wheel/CSS scrolling.
      if (typeof settings.scrollAnimatorEnabled !== "undefined")
        settings.scrollAnimatorEnabled = true
      console.log("WebEngineView size:", width, "x", height, "backgroundColor:", backgroundColor)
      forceActiveFocus()
      mainWindow.reloadWebClient.connect(reload)
      // Remote pages cannot navigate to bundled files. Keep this fixed native
      // destination separate from the external URL API and retain Back/Cancel.
      components.system.serverSettingsRequested.connect(function() {
        web.url = "qrc:///web-client/extension/find-webclient.html?choose=1";
      })
      components.system.serverSelectionFinished.connect(function(server, mode, target, history) {
        if (web.serverSelection) return;
        web.serverSelection = {
          target: target, started: false, history: history,
          previousAddress: components.settings.value("main", "userWebClient"),
          previousMode: components.settings.value("main", "serverConnectionMode")
        };
        components.settings.setValue("main", "userWebClient", server);
        components.settings.setValue("main", "serverConnectionMode", mode);
        web.url = target;
      })

      // Handle CSP workaround from C++
      components.system.pageContentReady.connect(function(html, finalUrl, hadCSP) {
        if (hadCSP) {
          console.log("CSP workaround: navigating to", finalUrl);
          web.url = finalUrl;
        }
      })

      var nativeshell =
      {
        sourceCode: components.system.getNativeShellScript(),
        injectionPoint: WebEngineScript.DocumentCreation,
        worldId: WebEngineScript.MainWorld
      }

      var webAppearance =
      {
        sourceCode: components.system.getWebAppearanceScript(),
        injectionPoint: WebEngineScript.DocumentCreation,
        worldId: WebEngineScript.ApplicationWorld
      }

      web.userScripts.collection = [ webAppearance, nativeshell ];
    }

    onLoadingChanged: function(loadingInfo)
    {
      // we use a timer here to switch to the webview since
      // it take a few moments for the webview to render
      // after it has loaded.
      //
      if (loadingInfo.status == WebEngineView.LoadStartedStatus)
      {
        if (web.serverSelection && loadingInfo.url.toString() === web.serverSelection.target)
          web.serverSelection.started = true;
        console.log("WebEngineLoadRequest starting: " + loadingInfo.url);
      }
      else if (loadingInfo.status == WebEngineView.LoadSucceededStatus)
      {
        if (web.serverSelection && web.serverSelection.started &&
            loadingInfo.url.toString() === web.url.toString() && /^https?:/.test(web.url.toString())) {
          // Only a loaded server page becomes a remembered server.
          if (web.serverSelection.history)
            components.settings.setValue("main", "knownServers", web.serverSelection.history);
          web.serverSelection = null;
          web.history.clear();
        }
        console.log("WebEngineLoadRequest success: " + loadingInfo.url);
        // Let the first composed web frame replace the startup cover instead
        // of briefly exposing Emby's blue loading canvas.
        if (mainWindow.startupCoverVisible)
          startupCoverTimer.restart()
      }
      else if (loadingInfo.status == WebEngineView.LoadFailedStatus)
      {
        if (web.serverSelection && web.serverSelection.started) {
          web.rollbackServerSelection();
          return;
        }
        console.log("WebEngineLoadRequest failure: " + loadingInfo.url + " error code: " + loadingInfo.errorCode);
        mainWindow.startupCoverVisible = false
        errorLabel.visible = true
        errorLabel.text = "无法加载 Emby 网页客户端。<br>" +
                          "请先尝试<a href='reload'>重新加载</a>。<br><br>错误详情：<pre>" +
                          loadingInfo.errorString + " [" + loadingInfo.errorCode + "]</pre><br><br>" +
                          "Provide the <a target='_blank' href='file://"+ components.system.logFilePath + "'>logfile</a> as well."
      }
    }

    onNewWindowRequested:
    {
      if (request.userInitiated)
      {
        console.log("Opening external URL: " + web.currentHoveredUrl)
        components.system.openExternalUrl(web.currentHoveredUrl)
      }
    }

    onFullScreenRequested:
    {
      console.log("Request fullscreen: " + request.toggleOn)
      components.window.setFullScreen(request.toggleOn)
      request.accept()
    }

    onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceID)
    {
      components.system.jsLog(level, sourceID + ":" + lineNumber + " " + message);
    }

    onCertificateError: function(error)
    {
      console.log(error.url + " :" + error.description + error.error)
      if (components.settings.ignoreSSLErrors()) {
        error.acceptCertificate()
      }
    }
  }

  Rectangle
  {
    id: startupCover
    anchors.fill: parent
    z: 300
    color: "#111112"
    visible: mainWindow.startupCoverVisible && !mainWindow.nativeVideoVisible

    Column
    {
      anchors.centerIn: parent
      spacing: 18

      Image
      {
        anchors.horizontalCenter: parent.horizontalCenter
        width: 112
        height: 112
        source: "qrc:/images/icon.png"
        fillMode: Image.PreserveAspectFit
        smooth: true
      }

      Text
      {
        anchors.horizontalCenter: parent.horizontalCenter
        text: "Tigerest Theater / 大河影院"
        color: "#f4f1ea"
        font.pixelSize: 20
        font.weight: Font.Medium
      }
    }
  }

  Text
  {
    id: errorLabel
    z: 5
    anchors.centerIn: parent
    color: "#999999"
    linkColor: "#a85dc3"
    text: "Generic error"
    font.pixelSize: 32
    font.bold: true
    visible: false
    verticalAlignment: Text.AlignVCenter
    textFormat: Text.StyledText
    onLinkActivated:
    {
      if (url == "reload")
      {
        errorLabel.visible = false
        web.reload()
      }
      else
      {
        Qt.openUrlExternally(url)
      }
    }
  }


  Rectangle
  {
    id: debug
    color: "black"
    z: 10
    anchors.centerIn: parent
    width: parent.width
    height: parent.height
    opacity: 0.7
    visible: mainWindow.showDebugLayer

    Text
    {
      id: debugLabel
      width: (parent.width - 50) / 2
      height: parent.height - 25
      anchors.left: parent.left
      anchors.leftMargin: 64
      anchors.top: parent.top
      anchors.topMargin: 54
      anchors.bottomMargin: 54
      color: "white"
      font.pixelSize: Math.round(height / 65)
      wrapMode: Text.WrapAnywhere

      function windowDebug()
      {
        var dbg = mainWindow.debugInfo + "Window and web\n";
        dbg += "  Window size: " + parent.width + "x" + parent.height + " - " + web.width + "x" + web.height + "\n";
        dbg += "  DevicePixel ratio: " + Screen.devicePixelRatio + "\n";

        return dbg;
      }

      text: windowDebug()
    }

    Text
    {
      id: videoLabel
      width: (parent.width - 50) / 2
      height: parent.height - 25
      anchors.right: parent.right
      anchors.left: debugLabel.right
      anchors.rightMargin: 64
      anchors.top: parent.top
      anchors.topMargin: 54
      anchors.bottomMargin: 54
      color: "white"
      font.pixelSize: Math.round(height / 65)
      wrapMode: Text.WrapAnywhere

      text: mainWindow.videoInfo
    }
  }

  property QtObject webChannel: web.webChannel

  Labs.SystemTrayIcon {
    visible: showSystemTrayIcon
    icon.source: "qrc:/images/icon.png"
    tooltip: "Tigerest Theater / 大河影院"

    onActivated: function(reason) {
      if (reason === Labs.SystemTrayIcon.Context) {
        // Right click: open context menu
        contextMenu.open()
        components.window.setCursorVisibility(true)
      } else {
        // All other clicks: restore window
        restoreWindow()
      }
    }

    menu: Labs.Menu {
      id: contextMenu
      Labs.MenuItem {
        text: qsTr("Restore")
        onTriggered: restoreWindow()
      }
      Labs.MenuSeparator {}
      Labs.MenuItem {
        text: qsTr("Quit")
        onTriggered: components.system.exit()
      }
    }
  }
}
