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
)

add_executable(test_systemcomponent test_systemcomponent.cpp)
target_link_libraries(test_systemcomponent jmp_core Qt6::Test)
target_include_directories(test_systemcomponent PRIVATE ${TEST_INCLUDE_DIRS})
target_compile_definitions(test_systemcomponent PRIVATE ${TEST_COMPILE_DEFS})
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

find_package(Python3 COMPONENTS Interpreter QUIET)
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
endif()
