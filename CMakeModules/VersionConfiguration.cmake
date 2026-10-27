# Get the current date.
string(TIMESTAMP CURRENT_DATE "%Y-%m-%d")

option(UPGRADE_DEBUG "" OFF)

# Read version from VERSION file
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/VERSION")
file(READ "${CMAKE_SOURCE_DIR}/VERSION" VERSION_STRING)
string(STRIP "${VERSION_STRING}" VERSION_STRING)

# Extract major.minor.patch for places that need it
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" VERSION_BASE "${VERSION_STRING}")
if(NOT VERSION_BASE)
  set(VERSION_BASE "0.0.0")
endif()

# The commit this build comes from, shown with the version on the update page.
# Git appends to the HEAD log on every commit and checkout, which reconfigures.
set(GIT_REVISION "")
find_package(Git QUIET)
if(GIT_FOUND)
  execute_process(COMMAND "${GIT_EXECUTABLE}" rev-parse --short=8 HEAD
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" RESULT_VARIABLE GIT_RESULT
    OUTPUT_VARIABLE GIT_OUTPUT OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  if(GIT_RESULT EQUAL 0 AND GIT_OUTPUT MATCHES "^[0-9a-f]+$")
    set(GIT_REVISION "${GIT_OUTPUT}")
  endif()
  execute_process(COMMAND "${GIT_EXECUTABLE}" rev-parse --path-format=absolute --git-path logs/HEAD
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" RESULT_VARIABLE GIT_RESULT
    OUTPUT_VARIABLE GIT_HEAD_LOG OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  if(GIT_RESULT EQUAL 0 AND EXISTS "${GIT_HEAD_LOG}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${GIT_HEAD_LOG}")
  endif()
endif()

set(VERSION_STRING_SHORT "${VERSION_BASE}")
set(CANONICAL_VERSION_STRING "${VERSION_BASE}")

configure_file(src/core/Version.cpp.in src/core/Version.cpp)
