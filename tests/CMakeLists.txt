cmake_minimum_required(VERSION 3.10...3.31)

set(CMAKE_AUTOMOC ON)

find_package(Qt6 ${REQUIRED_QT_VERSION} REQUIRED COMPONENTS Test)

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
target_link_libraries(test_windowmanager jmp_core Qt6::Test)
target_include_directories(test_windowmanager PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_windowmanager PRIVATE ${TEST_COMPILE_DEFS})
add_test(NAME test_windowmanager COMMAND test_windowmanager)
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

find_package(Python3 COMPONENTS Interpreter QUIET)
if(APPLE)
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
  add_test(NAME test_bundle_integrity
           COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_bundle_integrity.py)
endif()

find_program(Node_EXECUTABLE node)
if(Node_EXECUTABLE)
  add_test(NAME test_player_lifecycle
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_player_lifecycle.js)
  add_test(NAME test_stream_quality
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_stream_quality.js)
  add_test(NAME test_session_navigation
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_session_navigation.js)
  add_test(NAME test_web_appearance
           COMMAND ${Node_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_web_appearance.js)
endif()
