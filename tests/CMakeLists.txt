cmake_minimum_required(VERSION 3.10...3.31)

set(CMAKE_AUTOMOC ON)

add_executable(test_appupdate_policy test_appupdate_policy.cpp ../src/system/AppUpdatePolicy.cpp)
target_include_directories(test_appupdate_policy PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_appupdate_policy PRIVATE Qt6::Core Qt6::Test)
add_test(NAME test_appupdate_policy COMMAND test_appupdate_policy)

add_executable(test_appupdater test_appupdater.cpp ../src/system/AppUpdater.cpp ../src/system/AppUpdatePolicy.cpp)
target_include_directories(test_appupdater PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_appupdater PRIVATE Qt6::Core Qt6::Network Qt6::Test)
add_test(NAME test_appupdater COMMAND test_appupdater)

find_package(Qt6 ${REQUIRED_QT_VERSION} REQUIRED COMPONENTS Test)

if(WIN32)
  add_executable(test_compositor_frame_check test_compositor_frame_check.cpp)
  target_link_libraries(test_compositor_frame_check PRIVATE Qt6::Gui Qt6::Test)
  add_test(NAME test_compositor_frame_check COMMAND test_compositor_frame_check)
  add_executable(windows_compositor_capture windows_compositor_capture.cpp)
  target_link_libraries(windows_compositor_capture PRIVATE Qt6::Gui gdi32 user32)
endif()

if(WIN32)
  add_executable(test_rife_startup_dialog test_rife_startup_dialog.cpp ../src/ui/RifeStartupDialog.cpp)
  target_include_directories(test_rife_startup_dialog PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(test_rife_startup_dialog PRIVATE Qt6::Widgets Qt6::Test)
  add_test(NAME test_rife_startup_dialog COMMAND test_rife_startup_dialog)
  set_tests_properties(test_rife_startup_dialog PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()

set(TEST_INCLUDE_DIRS
  ${CMAKE_SOURCE_DIR}/src
  ${CMAKE_SOURCE_DIR}/src/core
  ${CMAKE_SOURCE_DIR}/src/shared
  ${CMAKE_SOURCE_DIR}/external
  ${CMAKE_SOURCE_DIR}/src/player
)

set(TEST_COMPILE_DEFS
  PREFIX="${CMAKE_INSTALL_PREFIX}"
  SOURCE_ROOT="${CMAKE_SOURCE_DIR}"
)

add_executable(test_systemcomponent test_systemcomponent.cpp)
target_link_libraries(test_systemcomponent jmp_core Qt6::Test)
target_include_directories(test_systemcomponent PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_systemcomponent PRIVATE ${TEST_COMPILE_DEFS})
file(GLOB TEST_SYSTEMCOMPONENT_NATIVE_SCRIPTS CONFIGURE_DEPENDS
  "${CMAKE_SOURCE_DIR}/native/*.js"
)
qt_add_resources(test_systemcomponent "test_systemcomponent_native_scripts"
  PREFIX "/web-client/extension"
  BASE "${CMAKE_SOURCE_DIR}/native"
  FILES ${TEST_SYSTEMCOMPONENT_NATIVE_SCRIPTS}
)
add_test(NAME test_systemcomponent COMMAND test_systemcomponent)

add_executable(test_log test_log.cpp)
target_link_libraries(test_log jmp_core Qt6::Test)
target_include_directories(test_log PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_log PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_log COMMAND test_log)

add_executable(test_report_diagnostics test_report_diagnostics.cpp ../src/utils/ReportDiagnostics.cpp)
target_include_directories(test_report_diagnostics PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_report_diagnostics PRIVATE Qt6::Core Qt6::Test)
add_test(NAME test_report_diagnostics COMMAND test_report_diagnostics)

add_executable(test_settings test_settings.cpp)
target_link_libraries(test_settings jmp_core Qt6::Test)
target_include_directories(test_settings PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_settings PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_settings COMMAND test_settings)

add_executable(test_displaymanager test_displaymanager.cpp)
target_link_libraries(test_displaymanager jmp_core Qt6::Test)
target_include_directories(test_displaymanager PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_displaymanager PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_displaymanager COMMAND test_displaymanager)

add_executable(test_windowmanager test_windowmanager.cpp)
qt_add_resources(test_windowmanager "test_windowmanager_resources"
  PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
  FILES "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
target_link_libraries(test_windowmanager jmp_core Qt6::Test)
target_include_directories(test_windowmanager PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_windowmanager PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_windowmanager COMMAND test_windowmanager)
if(WIN32)
add_executable(test_window_chrome test_window_chrome.cpp)
target_link_libraries(test_window_chrome PRIVATE Qt6::Quick Qt6::Test)
target_compile_definitions(test_window_chrome PRIVATE SOURCE_ROOT="${CMAKE_SOURCE_DIR}" TEST_QML_IMPORTS="${CMAKE_BINARY_DIR}/output/qml")
qt_add_resources(test_window_chrome window_chrome_test_icons
  PREFIX "/images"
  BASE "${CMAKE_SOURCE_DIR}/resources/images"
  FILES "${CMAKE_SOURCE_DIR}/resources/images/icon.png")
add_test(NAME test_window_chrome COMMAND test_window_chrome)
  add_test(NAME test_windowmanager_opengl COMMAND test_windowmanager
    testNativeFullscreenKeepsWindowsComposition)
  set_tests_properties(test_windowmanager_opengl PROPERTIES ENVIRONMENT "QSG_RHI_BACKEND=opengl")
  set_tests_properties(test_windowmanager test_windowmanager_opengl PROPERTIES RUN_SERIAL TRUE)
endif()
if(APPLE)
  # Native macOS maximize/fullscreen transitions are asynchronous and can be
  # rejected for an inactive test process. Exercise WindowManager's state
  # transitions deterministically without depending on the desktop session.
  set_tests_properties(test_windowmanager PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()

add_executable(test_playback_identity test_playback_identity.cpp)
target_link_libraries(test_playback_identity jmp_core Qt6::Test)
target_include_directories(test_playback_identity PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_playback_identity PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_playback_identity COMMAND test_playback_identity)

add_executable(test_danmaku_metadata test_danmaku_metadata.cpp)
target_link_libraries(test_danmaku_metadata jmp_core Qt6::Test)
target_include_directories(test_danmaku_metadata PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_danmaku_metadata PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_danmaku_metadata COMMAND test_danmaku_metadata)

add_executable(test_danmaku_style_config test_danmaku_style_config.cpp)
target_link_libraries(test_danmaku_style_config jmp_core Qt6::Test)
target_include_directories(test_danmaku_style_config PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_danmaku_style_config PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_danmaku_style_config COMMAND test_danmaku_style_config)

add_executable(test_audio_device_dispatch test_audio_device_dispatch.cpp)
target_link_libraries(test_audio_device_dispatch jmp_core Qt6::Test)
target_include_directories(test_audio_device_dispatch PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_audio_device_dispatch PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_audio_device_dispatch COMMAND test_audio_device_dispatch)
set_tests_properties(test_audio_device_dispatch PROPERTIES TIMEOUT 15)

add_executable(test_mpv_console test_mpv_console.cpp)
target_link_libraries(test_mpv_console jmp_core Qt6::Test)
target_include_directories(test_mpv_console PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_mpv_console PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_mpv_console COMMAND test_mpv_console)

add_executable(test_emby_uosc_playlist test_emby_uosc_playlist.cpp)
qt_add_resources(test_emby_uosc_playlist "test_emby_uosc_playlist_resources"
  PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
  FILES "${CMAKE_SOURCE_DIR}/resources/mpv/mpv.conf.in"
        "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
target_link_libraries(test_emby_uosc_playlist jmp_core Qt6::Test)
target_include_directories(test_emby_uosc_playlist PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_emby_uosc_playlist PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_emby_uosc_playlist COMMAND test_emby_uosc_playlist)
set_tests_properties(test_emby_uosc_playlist PROPERTIES TIMEOUT 30 ENVIRONMENT "QT_QPA_PLATFORM=offscreen")

find_package(Python3 COMPONENTS Interpreter QUIET)
if(Python3_Interpreter_FOUND)
  add_test(NAME test_compositor_release_gate
           COMMAND ${Python3_EXECUTABLE} -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_compositor_release_gate.py")
  add_test(NAME test_macos_rife_runtime_pin COMMAND "${Python3_EXECUTABLE}" -B -X utf8
    "${CMAKE_CURRENT_SOURCE_DIR}/test_macos_rife_runtime_pin.py")
endif()
if(WIN32)
  add_executable(test_rife_windows_ipc test_rife_windows_ipc.cpp)
  target_link_libraries(test_rife_windows_ipc jmp_core Qt6::Test)
  target_include_directories(test_rife_windows_ipc PRIVATE ${TEST_INCLUDE_DIRS})
  qt_add_resources(test_rife_windows_ipc "test_rife_windows_ipc_resources"
    PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
    FILES "${CMAKE_SOURCE_DIR}/resources/mpv/mpv.conf.in"
          "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
  add_test(NAME test_rife_windows_ipc COMMAND test_rife_windows_ipc)
  if(USE_STATIC_MPVQT)
    add_executable(test_rife_player_playback test_rife_player_playback.cpp)
    qt_add_resources(test_rife_player_playback "test_rife_player_playback_resources"
      PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
      FILES "${CMAKE_SOURCE_DIR}/resources/mpv/mpv.conf.in"
            "${CMAKE_SOURCE_DIR}/resources/mpv/input.conf"
            "${CMAKE_SOURCE_DIR}/resources/mpv/plugins/stats.lua"
            "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
    target_link_libraries(test_rife_player_playback jmp_core Qt6::Test)
    target_include_directories(test_rife_player_playback PRIVATE ${TEST_INCLUDE_DIRS})
    target_compile_definitions(test_rife_player_playback PRIVATE ${TEST_COMPILE_DEFS})
    add_dependencies(test_rife_player_playback tigerest_rife_vs)
    add_test(NAME test_rife_player_lifecycle COMMAND test_rife_player_playback
      nativeVolumeChangesAreObserved
      replacementDoesNotFinishOnSupersededNativeStart
      preparationPauseReportsBufferingUntilUserPauses
      stopCancelsPreparationBeforeNativeEndFileArrives
      nativePreparationToggleChangesIntentWithoutReleasingHold
      preparationOverlayAndResumeFollowTheCurrentHold
      preparationResumeRetainsHoldUntilAcknowledged
      rejectedPreparationResumeReportsPlaybackError
      preparationResumeReplyIsScopedToItemAndPauseIntent
      preparationResumeErrorsAndMissingRepliesAreBounded
      nativeSpaceDuringPreparationDoesNotRacePhysicalPause
      queuedPreparationTogglesAfterResumeRemainDistinct
      qtSpaceAndDoubleClickPreservePreparationIntent
      preparationOverlayCommandsAreAcceptedByMpv
      renderApiRemainsVisibleWhileItsVoReconfigures
      renderApiWaitsForRestartBeforeQualifyingItsFormat
      stopCancelsPendingRecoveryReplacement
      recoveryDoesNotMarkAnUnrelatedNativeStart)
    set_tests_properties(test_rife_player_lifecycle PROPERTIES TIMEOUT 30
      ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
  endif()
endif()
if(WIN32 AND Python3_Interpreter_FOUND)
  add_executable(app_update_transfer_host app_update_transfer_host.cpp ../src/system/AppUpdater.cpp ../src/system/AppUpdatePolicy.cpp)
  target_include_directories(app_update_transfer_host PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(app_update_transfer_host PRIVATE Qt6::Core Qt6::Network)
  add_test(NAME test_app_update_transfer COMMAND "${Python3_EXECUTABLE}" -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_app_update_transfer.py")
  set_tests_properties(test_app_update_transfer PROPERTIES TIMEOUT 90
    ENVIRONMENT "APP_UPDATE_TRANSFER_HOST=$<TARGET_FILE:app_update_transfer_host>")
  add_test(NAME test_openssl_runtime_deployment COMMAND "${Python3_EXECUTABLE}" -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_openssl_runtime_deployment.py")
  add_executable(rife_extension_manager_host rife_extension_manager_host.cpp)
  target_link_libraries(rife_extension_manager_host PRIVATE tigerest_rife_control)
  add_test(NAME test_rife_extension_manager COMMAND "${Python3_EXECUTABLE}" -B -X utf8
    "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_extension_manager.py")
  add_test(NAME test_rife_extension_download COMMAND "${Python3_EXECUTABLE}" -B -X utf8
    "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_extension_download.py")
  set_tests_properties(test_rife_extension_download PROPERTIES TIMEOUT 120
    ENVIRONMENT "RIFE_EXTENSION_MANAGER_HOST=$<TARGET_FILE:rife_extension_manager_host>"
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  set_tests_properties(test_rife_extension_manager PROPERTIES TIMEOUT 90
    ENVIRONMENT "RIFE_EXTENSION_MANAGER_HOST=$<TARGET_FILE:rife_extension_manager_host>"
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  add_executable(rife_extension_archive_host rife_extension_archive_host.cpp)
  target_link_libraries(rife_extension_archive_host PRIVATE tigerest_rife_control)
  add_test(NAME test_rife_extension_native COMMAND "${Python3_EXECUTABLE}" -B -X utf8
    "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_extension_native.py")
  set_tests_properties(test_rife_extension_native PROPERTIES TIMEOUT 60
    ENVIRONMENT "RIFE_EXTENSION_ARCHIVE_HOST=$<TARGET_FILE:rife_extension_archive_host>"
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  if(USE_STATIC_MPVQT)
  add_executable(rife_player_benchmark rife_player_benchmark.cpp)
  target_link_libraries(rife_player_benchmark PRIVATE jmp_core dbghelp)
  target_include_directories(rife_player_benchmark PRIVATE ${TEST_INCLUDE_DIRS})
  target_compile_definitions(rife_player_benchmark PRIVATE ${TEST_COMPILE_DEFS})
  file(GLOB_RECURSE RIFE_BENCH_MPV_RESOURCES CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/resources/mpv/*")
  qt_add_resources(rife_player_benchmark "rife_player_benchmark_resources"
    PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
    FILES ${RIFE_BENCH_MPV_RESOURCES} "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
  add_executable(test_rife_player_startup test_rife_player_startup.cpp)
  target_link_libraries(test_rife_player_startup jmp_core Qt6::Test)
  add_dependencies(test_rife_player_startup tigerest_rife_vs)
  target_include_directories(test_rife_player_startup PRIVATE ${TEST_INCLUDE_DIRS})
  target_compile_definitions(test_rife_player_startup PRIVATE ${TEST_COMPILE_DEFS})
  qt_add_resources(test_rife_player_startup "test_rife_player_startup_resources"
    PREFIX "/" BASE "${CMAKE_SOURCE_DIR}/resources"
    FILES "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json"
          "${CMAKE_SOURCE_DIR}/resources/rife/windows-catalog.json")
  add_test(NAME test_rife_player_startup COMMAND test_rife_player_startup)
  set_tests_properties(test_rife_player_startup PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE
    ENVIRONMENT "RIFE_TEST_PLAYER_MONITOR=$<TARGET_FILE:tigerest_rife_vs>"
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  endif()
  add_executable(test_rife_runtime_manager test_rife_runtime_manager.cpp)
  target_link_libraries(test_rife_runtime_manager PRIVATE tigerest_rife_control)
  target_compile_definitions(test_rife_runtime_manager PRIVATE
    RIFE_HOST_TEST_PYTHON="${Python3_EXECUTABLE}"
    RIFE_MANAGER_WORKER_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/rife_runtime_worker_fixture.py")
  add_test(NAME test_rife_runtime_manager COMMAND test_rife_runtime_manager)
  set_tests_properties(test_rife_runtime_manager PROPERTIES TIMEOUT 90
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  foreach(case runtime runtime_prepare mpv_build build_sources mpv_recipe engine_cache engine_prepare windows_job timing_tracker windows_dll_lifecycle)
    add_test(NAME test_rife_${case} COMMAND "${Python3_EXECUTABLE}" -m unittest discover
      -s "${CMAKE_CURRENT_SOURCE_DIR}" -p "test_rife_${case}.py" -v)
    set_tests_properties(test_rife_${case} PROPERTIES TIMEOUT 180 LABELS "rife-runtime")
  endforeach()
  if(DEFINED ENV{RIFE_TEST_RUNTIME})
    add_test(NAME test_rife_inference COMMAND "${Python3_EXECUTABLE}" -m unittest discover
      -s "${CMAKE_CURRENT_SOURCE_DIR}" -p "test_rife_inference.py" -v)
    set_tests_properties(test_rife_inference PROPERTIES TIMEOUT 900 RUN_SERIAL TRUE LABELS "rife-model")
  endif()
  if(DEFINED ENV{RIFE_TEST_RUNTIME})
    add_test(NAME test_rife_trt_pipeline COMMAND "${Python3_EXECUTABLE}" -m unittest discover
      -s "${CMAKE_CURRENT_SOURCE_DIR}" -p "test_rife_trt_pipeline.py" -v)
    set_tests_properties(test_rife_trt_pipeline PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-model")
  endif()
  if(DEFINED ENV{RIFE_TEST_ENGINE_RUNTIME})
    set_tests_properties(test_rife_engine_prepare PROPERTIES TIMEOUT 930 RUN_SERIAL TRUE)
  endif()
  if(DEFINED ENV{RIFE_TEST_RUNTIME})
    add_executable(test_rife_vsscript_runtime test_rife_vsscript_runtime.cpp)
    target_include_directories(test_rife_vsscript_runtime PRIVATE ../dev/windows/rife/include)
    target_link_libraries(test_rife_vsscript_runtime PRIVATE tigerest_rife_control)
    foreach(mode fresh foreign)
      add_test(NAME test_rife_vsscript_${mode} COMMAND test_rife_vsscript_runtime --${mode})
      set_tests_properties(test_rife_vsscript_${mode} PROPERTIES TIMEOUT 30
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
    endforeach()
    add_test(NAME test_rife_vsscript_integrity COMMAND "${Python3_EXECUTABLE}" -B -X utf8
      "${CMAKE_SOURCE_DIR}/dev/windows/rife/probe_runtime.py" --runtime "$ENV{RIFE_TEST_RUNTIME}"
      --verify-only --report "${CMAKE_BINARY_DIR}/rife-vsscript-integrity.json")
    set_tests_properties(test_rife_vsscript_integrity PROPERTIES TIMEOUT 60)
    if(DEFINED ENV{RIFE_TEST_MPV_DLL})
      add_executable(test_rife_mpv_startup test_rife_mpv_startup.cpp)
      target_include_directories(test_rife_mpv_startup PRIVATE ${MPV_INCLUDE_DIR})
      target_link_libraries(test_rife_mpv_startup PRIVATE tigerest_rife_control)
      add_test(NAME test_rife_mpv_early_activation COMMAND test_rife_mpv_startup)
      add_test(NAME test_rife_mpv_late_activation COMMAND test_rife_mpv_startup --late)
      set_tests_properties(test_rife_mpv_early_activation test_rife_mpv_late_activation PROPERTIES TIMEOUT 30
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
    endif()
    add_executable(test_rife_windows_stream test_rife_windows_stream.cpp)
    target_include_directories(test_rife_windows_stream PRIVATE ${MPV_INCLUDE_DIR} ../src/player)
    target_link_libraries(test_rife_windows_stream PRIVATE tigerest_rife_control dbghelp)
    if(DEFINED ENV{RIFE_TEST_EOF_MPV_DLL})
      add_test(NAME test_rife_windows_stream COMMAND "${Python3_EXECUTABLE}" -B -X utf8 -m unittest discover
        -s "${CMAKE_CURRENT_SOURCE_DIR}" -p "test_rife_windows_stream.py" -v)
      set_tests_properties(test_rife_windows_stream PROPERTIES TIMEOUT 180 RUN_SERIAL TRUE
        ENVIRONMENT "RIFE_TEST_STREAM_HOST=$<TARGET_FILE:test_rife_windows_stream>;RIFE_TEST_MONITOR_PLUGIN=$<TARGET_FILE:tigerest_rife_vs>"
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
      foreach(fixture RIFE_TEST_EOF_MPV_DLL RIFE_TEST_RUNTIME RIFE_TEST_STREAM_PREPARED RIFE_TEST_FFMPEG RIFE_TEST_FFPROBE)
        if(DEFINED ENV{${fixture}})
          set_property(TEST test_rife_windows_stream APPEND PROPERTY ENVIRONMENT "${fixture}=$ENV{${fixture}}")
        endif()
      endforeach()
      if(USE_STATIC_MPVQT AND DEFINED ENV{RIFE_TEST_STREAM_PREPARED})
        add_test(NAME test_rife_player_playback COMMAND "${Python3_EXECUTABLE}" -B -X utf8 -m unittest discover
          -s "${CMAKE_CURRENT_SOURCE_DIR}" -p "test_rife_player_playback.py" -v)
        set_tests_properties(test_rife_player_playback PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE
          ENVIRONMENT "RIFE_TEST_PLAYER_HOST=$<TARGET_FILE:test_rife_player_playback>;RIFE_TEST_PLAYER_STATS=$<TARGET_FILE:tigerest_rife>;RIFE_TEST_PLAYER_MONITOR=$<TARGET_FILE:tigerest_rife_vs>")
        foreach(fixture RIFE_TEST_EOF_MPV_DLL RIFE_TEST_RUNTIME RIFE_TEST_STREAM_PREPARED RIFE_TEST_FFMPEG)
          if(DEFINED ENV{${fixture}})
            set_property(TEST test_rife_player_playback APPEND PROPERTY ENVIRONMENT "${fixture}=$ENV{${fixture}}")
          endif()
        endforeach()
      endif()
    endif()
    add_executable(test_rife_monitor_registry test_rife_monitor_registry.cpp)
    target_include_directories(test_rife_monitor_registry PRIVATE ../dev/windows/rife/include)
    target_link_libraries(test_rife_monitor_registry PRIVATE tigerest_rife Qt6::Core)
    add_dependencies(test_rife_monitor_registry tigerest_rife_vs)
    add_test(NAME test_rife_monitor_registry COMMAND test_rife_monitor_registry
      "$ENV{RIFE_TEST_RUNTIME}/python/Lib/site-packages/vapoursynth/libvapoursynth.dll"
      $<TARGET_FILE:tigerest_rife_vs>)
    set_tests_properties(test_rife_monitor_registry PROPERTIES TIMEOUT 30
      ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  endif()
endif()
if(APPLE OR WIN32)
  add_executable(test_rife_timing test_rife_timing.cpp ../src/player/interpolation/FrameTiming.cpp)
  foreach(case policy controller metrics windows_control)
    add_executable(test_rife_${case} test_rife_${case}.cpp)
    target_link_libraries(test_rife_${case} PRIVATE tigerest_rife_control)
    add_test(NAME test_rife_${case} COMMAND test_rife_${case})
    if(WIN32)
      set_tests_properties(test_rife_${case} PROPERTIES ENVIRONMENT_MODIFICATION
        "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
    endif()
  endforeach()
  target_compile_features(test_rife_timing PRIVATE cxx_std_17)
  target_include_directories(test_rife_timing PRIVATE ../src/player/interpolation)
  add_test(NAME test_rife_timing COMMAND test_rife_timing)
  add_executable(test_rife_poll_access test_rife_poll_access.cpp)
  target_include_directories(test_rife_poll_access PRIVATE ../src/player)
  target_link_libraries(test_rife_poll_access PRIVATE tigerest_rife_control)
  add_test(NAME test_rife_poll_access COMMAND test_rife_poll_access)
  if(WIN32)
    set_tests_properties(test_rife_poll_access PROPERTIES ENVIRONMENT_MODIFICATION
      "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  endif()
endif()
if(APPLE)
  add_executable(test_coreaudio_hotplug_lifecycle test_coreaudio_hotplug_lifecycle.cpp)
  target_include_directories(test_coreaudio_hotplug_lifecycle PRIVATE ${MPV_INCLUDE_DIR})
  target_link_libraries(test_coreaudio_hotplug_lifecycle PRIVATE ${MPV_LIBRARY})
  add_test(NAME test_coreaudio_hotplug_lifecycle COMMAND test_coreaudio_hotplug_lifecycle)
  set_tests_properties(test_coreaudio_hotplug_lifecycle PROPERTIES TIMEOUT 75 LABELS "macos-native")
  set(RIFE_TEST_VS_PYTHON "" CACHE FILEPATH "Python interpreter with the test VapourSynth runtime")
  set(RIFE_TEST_MPV "" CACHE FILEPATH "EOF-aware mpv binary for RIFE integration tests")
  set(RIFE_TEST_VSSCRIPT_LIB "" CACHE FILEPATH "VSScript runtime for native mpv integration tests")
  if(RIFE_TEST_MODEL_ROOT AND RIFE_TEST_VS_PYTHON)
    set(RIFE_TEST_ENV "RIFE_VS_PLUGIN=$<TARGET_FILE:tigerest_rife_vs>;RIFE_SMALL_MODEL=${RIFE_TEST_MODEL_ROOT}/128-fp32")
    foreach(case vapoursynth vpy)
      add_test(NAME test_rife_${case} COMMAND "${RIFE_TEST_VS_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_${case}.py")
      set_tests_properties(test_rife_${case} PROPERTIES ENVIRONMENT "${RIFE_TEST_ENV}" TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-stream")
    endforeach()
    if(RIFE_TEST_MPV AND RIFE_TEST_VSSCRIPT_LIB AND Python3_Interpreter_FOUND)
      add_executable(test_rife_controller_live test_rife_controller_live.cpp)
      target_include_directories(test_rife_controller_live PRIVATE ../src/player ${MPV_INCLUDE_DIR})
      target_link_libraries(test_rife_controller_live PRIVATE tigerest_rife_control ${MPV_LIBRARY})
      add_test(NAME test_rife_controller_live COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_controller_live.py" $<TARGET_FILE:test_rife_controller_live>)
      set_tests_properties(test_rife_controller_live PROPERTIES
        ENVIRONMENT "${RIFE_TEST_ENV};VSSCRIPT_PATH=${RIFE_TEST_VSSCRIPT_LIB}"
        TIMEOUT 60 RUN_SERIAL TRUE LABELS "rife-stream")
      foreach(case mpv_eof streaming stream_lifecycle uosc)
        add_test(NAME test_rife_${case} COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_${case}.py")
        set_tests_properties(test_rife_${case} PROPERTIES
          ENVIRONMENT "${RIFE_TEST_ENV};RIFE_MPV_BINARY=${RIFE_TEST_MPV};VSSCRIPT_PATH=${RIFE_TEST_VSSCRIPT_LIB}"
          TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-stream")
      endforeach()
    endif()
  endif()
  add_executable(test_rife_engine test_rife_engine.mm)
  target_compile_options(test_rife_engine PRIVATE -fobjc-arc)
  target_link_libraries(test_rife_engine PRIVATE tigerest_rife)
  add_executable(test_rife_split_engine test_rife_split_engine.mm)
  target_compile_options(test_rife_split_engine PRIVATE -fobjc-arc)
  target_link_libraries(test_rife_split_engine PRIVATE tigerest_rife)
  add_executable(test_rife_metal_warp test_rife_metal_warp.mm)
  target_compile_options(test_rife_metal_warp PRIVATE -fobjc-arc)
  target_link_libraries(test_rife_metal_warp PRIVATE tigerest_rife "-framework Foundation" "-framework CoreML")
  add_test(NAME test_rife_metal_warp COMMAND test_rife_metal_warp)
  set_tests_properties(test_rife_metal_warp PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE LABELS "rife-metal")
  if(RIFE_TEST_MODEL_ROOT)
    add_executable(test_rife_coarse_metal test_rife_coarse_metal.mm)
    target_compile_options(test_rife_coarse_metal PRIVATE -fobjc-arc)
    target_link_libraries(test_rife_coarse_metal PRIVATE tigerest_rife "-framework Foundation" "-framework CoreML")
    if(EXISTS "${RIFE_TEST_MODEL_ROOT}/192-coarse-stages/coarse-fixture")
      add_test(NAME test_rife_coarse_metal COMMAND test_rife_coarse_metal
        "${RIFE_TEST_MODEL_ROOT}/192-coarse-stages/coarse-fixture")
      set_tests_properties(test_rife_coarse_metal PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE LABELS "rife-metal")
    endif()
    add_test(NAME test_rife_engine COMMAND test_rife_engine
      "${RIFE_TEST_MODEL_ROOT}/1080-grid-half-fp32" "${RIFE_TEST_MODEL_ROOT}/128-fp32")
    set_tests_properties(test_rife_engine PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-model")
    if(EXISTS "${RIFE_TEST_MODEL_ROOT}/1080-split-refine/manifest.json")
      add_test(NAME test_rife_split_engine COMMAND test_rife_split_engine
        "${RIFE_TEST_MODEL_ROOT}/1080-split-refine")
      set_tests_properties(test_rife_split_engine PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-model")
      add_test(NAME test_rife_split_metal COMMAND test_rife_split_engine
        "${RIFE_TEST_MODEL_ROOT}/1080-split-refine" --metal)
      set_tests_properties(test_rife_split_metal PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-model")
      if(EXISTS "${RIFE_TEST_MODEL_ROOT}/1080-split-refine/Stage0.mlpackage")
        add_test(NAME test_rife_coarse_engine COMMAND test_rife_split_engine
          "${RIFE_TEST_MODEL_ROOT}/1080-split-refine" --coarse)
        set_tests_properties(test_rife_coarse_engine PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "rife-model")
      endif()
    endif()
  endif()
  add_executable(test_mpv_svp test_mpv_svp.cpp)
  target_link_libraries(test_mpv_svp jmp_core Qt6::Test)
  target_include_directories(test_mpv_svp PRIVATE ${TEST_INCLUDE_DIRS})
  target_compile_definitions(test_mpv_svp PRIVATE ${TEST_COMPILE_DEFS})
  qt_add_resources(test_mpv_svp "test_mpv_svp_resources"
    PREFIX "/"
    BASE "${CMAKE_SOURCE_DIR}/resources"
    FILES "${CMAKE_SOURCE_DIR}/resources/mpv/mpv.conf.in"
          "${CMAKE_SOURCE_DIR}/resources/settings/settings_description.json")
  add_test(NAME test_mpv_svp COMMAND test_mpv_svp)
  add_executable(test_macos_pause test_macos_pause.mm)
  target_link_libraries(test_macos_pause jmp_core Qt6::Test "-framework AppKit")
  target_include_directories(test_macos_pause PRIVATE ${TEST_INCLUDE_DIRS})
  target_compile_definitions(test_macos_pause PRIVATE ${TEST_COMPILE_DEFS})
  option(ENABLE_MACOS_NATIVE_INPUT_TEST "Run input smoke test using a real macvk window and desktop" OFF)
  if(ENABLE_MACOS_NATIVE_INPUT_TEST)
    add_test(NAME test_macos_pause COMMAND test_macos_pause)
    set_tests_properties(test_macos_pause PROPERTIES TIMEOUT 45 RUN_SERIAL TRUE LABELS "macos-native")
  endif()
endif()

if(Python3_Interpreter_FOUND)
  add_test(NAME test_rife_extension_package
           COMMAND ${Python3_EXECUTABLE} -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_rife_extension_package.py")
  if(WIN32)
    add_test(NAME test_mpv_stats_overlay
             COMMAND ${Python3_EXECUTABLE} -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_mpv_stats_overlay.py")
    set_tests_properties(test_mpv_stats_overlay PROPERTIES TIMEOUT 60
      ENVIRONMENT "TIGEREST_STATS_MPV_DLL=${CMAKE_BINARY_DIR}/output/libmpv-2.dll")
  endif()
  add_test(NAME test_mpv_runtime_deployment
           COMMAND ${Python3_EXECUTABLE} -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_mpv_runtime_deployment.py")
  add_test(NAME test_webengine_runtime_deployment
           COMMAND ${Python3_EXECUTABLE} -B -X utf8 "${CMAKE_CURRENT_SOURCE_DIR}/test_webengine_runtime_deployment.py")
  add_test(NAME test_bundle_integrity
           COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_bundle_integrity.py)
endif()

find_program(Node_EXECUTABLE node)
if(Node_EXECUTABLE)
  add_test(NAME test_home_data
           COMMAND ${Node_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test_home_data.js
                   ${CMAKE_CURRENT_SOURCE_DIR}/test_home_backdrop.js
                   ${CMAKE_CURRENT_SOURCE_DIR}/test_home_orders.js
                   ${CMAKE_CURRENT_SOURCE_DIR}/test_home_motion.js
                   ${CMAKE_CURRENT_SOURCE_DIR}/test_home_registration.js)
  add_test(NAME test_home_motion_webengine
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_home_motion_ui.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_home_motion_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  add_test(NAME test_home_motion_cache_webengine
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_home_motion_cache_ui.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_home_motion_cache_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  add_test(NAME test_home_gallery_webengine
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_home_gallery_ui.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_home_gallery_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  add_test(NAME test_community_client
           COMMAND ${Node_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test_community_client.js
                   ${CMAKE_CURRENT_SOURCE_DIR}/test_community_registration.js)
  add_test(NAME test_community_reports_webengine
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_community_reports_ui.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_community_reports_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  add_test(NAME test_community_report_diagnostics_webengine
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_community_report_diagnostics_ui.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_community_report_diagnostics_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  add_test(NAME test_report_diagnostics_bridge
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_report_diagnostics_bridge.cjs
                   $<TARGET_FILE:${MAIN_TARGET}> --webengine)
  set_tests_properties(test_report_diagnostics_bridge PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
  add_test(NAME test_rife_windows_settings
           COMMAND ${Node_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test_rife_windows_settings.js)
  add_test(NAME test_native_settings_registration
           COMMAND ${Node_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test_native_settings_registration.js)
  add_test(NAME test_server_onboarding
           COMMAND ${Node_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test_server_onboarding.js)
  execute_process(COMMAND ${Node_EXECUTABLE} -p "typeof WebSocket === 'function' && typeof fetch === 'function'"
                  OUTPUT_VARIABLE NODE_HAS_WEBENGINE_TEST_APIS OUTPUT_STRIP_TRAILING_WHITESPACE)
  if(WIN32 AND NODE_HAS_WEBENGINE_TEST_APIS STREQUAL "true")
    add_test(NAME test_update_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_update_ui.cjs
                     $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_update_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    if(Python3_Interpreter_FOUND)
      add_test(NAME test_windows_web_controls
               COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_windows_web_controls.cjs
                       $<TARGET_FILE:${MAIN_TARGET}> --stage=ui)
      set_tests_properties(test_windows_web_controls PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE
                           ENVIRONMENT "TEST_PYTHON=${Python3_EXECUTABLE}")
    endif()
    add_test(NAME test_community_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_community_ui.cjs
                     $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_community_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    add_test(NAME test_community_messages_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_community_messages_ui.cjs
                     $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_community_messages_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    add_test(NAME test_community_pagination_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_community_pagination.cjs
                      $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_community_pagination_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    add_test(NAME test_settings_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_settings_ui.cjs
                      $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_settings_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    add_test(NAME test_android_content_insets_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_android_content_insets.cjs
                      $<TARGET_FILE:${MAIN_TARGET}> --webengine)
    set_tests_properties(test_android_content_insets_webengine PROPERTIES TIMEOUT 60 RUN_SERIAL TRUE)
    add_test(NAME test_webengine_startup
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_webengine_startup.js
                     $<TARGET_FILE:${MAIN_TARGET}>)
    set_tests_properties(test_webengine_startup PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
    add_test(NAME test_windows_compositor
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_windows_compositor.cjs
                     $<TARGET_FILE:${MAIN_TARGET}> --webengine
                     --capture=$<TARGET_FILE:windows_compositor_capture>
                     --output=${CMAKE_BINARY_DIR}/compositor-native-test)
    set_tests_properties(test_windows_compositor PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE LABELS "windows-visual")
    add_test(NAME test_unicode_command_line
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_unicode_command_line.js
                     $<TARGET_FILE:TigerestTheater>)
    set_tests_properties(test_unicode_command_line PROPERTIES TIMEOUT 20 RUN_SERIAL TRUE)
    add_test(NAME test_server_onboarding_webengine
             COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_server_onboarding_webengine.js
                     $<TARGET_FILE:${MAIN_TARGET}>)
    set_tests_properties(test_server_onboarding_webengine PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
  endif()
  add_test(NAME test_player_lifecycle
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_player_lifecycle.js)
  add_test(NAME test_stream_quality
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_stream_quality.js)
  add_test(NAME test_android_playlist
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_android_playlist.cjs)
  add_test(NAME test_session_navigation
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_session_navigation.js)
  add_test(NAME test_web_appearance
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_web_appearance.js)
  add_test(NAME test_compositor_evidence
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_compositor_evidence.cjs)
endif()
if(WIN32)
  get_property(_rife_host_tests DIRECTORY PROPERTY TESTS)
  foreach(_test IN LISTS _rife_host_tests)
    set_property(TEST ${_test} APPEND PROPERTY ENVIRONMENT_MODIFICATION
      "PATH=path_list_prepend:$<TARGET_FILE_DIR:tigerest_rife>")
  endforeach()
endif()
