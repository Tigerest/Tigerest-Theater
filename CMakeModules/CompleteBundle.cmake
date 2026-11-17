if(APPLE)
  set(SCRIPT CompleteBundleMac)
elseif(WIN32)
  if(CMAKE_VERSION VERSION_LESS 3.19)
    message(FATAL_ERROR "Windows verified mpv/WebEngine deployment requires CMake 3.19 or newer")
  endif()
  set(SCRIPT CompleteBundleWin)
  set(TIGEREST_WEBENGINE_RUNTIME "$ENV{TIGEREST_WEBENGINE_RUNTIME}" CACHE PATH
      "Patched QtWebEngine runtime to deploy with the matching Qt version")
  file(TO_CMAKE_PATH "${TIGEREST_WEBENGINE_RUNTIME}" TIGEREST_WEBENGINE_RUNTIME)
  include("${CMAKE_SOURCE_DIR}/CMakeModules/ValidateWindowsWebEngine.cmake")
  tigerest_validate_webengine("${TIGEREST_WEBENGINE_RUNTIME}" "${Qt6Core_VERSION}" "${CMAKE_SOURCE_DIR}")
  set(TIGEREST_OPENSSL_RUNTIME_DIR "$ENV{TIGEREST_OPENSSL_RUNTIME_DIR}" CACHE PATH
      "Directory containing release-pinned Windows OpenSSL DLLs and licenses")
  file(TO_CMAKE_PATH "${TIGEREST_OPENSSL_RUNTIME_DIR}" TIGEREST_OPENSSL_RUNTIME_DIR)
  include("${CMAKE_SOURCE_DIR}/CMakeModules/DeployWindowsOpenSSL.cmake")
  tigerest_validate_openssl("${TIGEREST_OPENSSL_RUNTIME_DIR}" "${QTROOT}"
                           "${CMAKE_SOURCE_DIR}/dev/windows/tls/runtime-lock.json")
  # Optional so developer and CI builds need not fetch NVIDIA's 436 MB wheel;
  # release packages set it (dev/windows/nvidia-vfx/README.md).
  set(TIGEREST_NVIDIA_VFX_RUNTIME_DIR "$ENV{TIGEREST_NVIDIA_VFX_RUNTIME_DIR}" CACHE PATH
      "Directory containing the hash-pinned NVIDIA Video Effects runtime for frame generation")
  file(TO_CMAKE_PATH "${TIGEREST_NVIDIA_VFX_RUNTIME_DIR}" TIGEREST_NVIDIA_VFX_RUNTIME_DIR)
  if(TIGEREST_NVIDIA_VFX_RUNTIME_DIR)
    include("${CMAKE_SOURCE_DIR}/CMakeModules/DeployWindowsNvidiaVfx.cmake")
    tigerest_validate_nvidia_vfx("${TIGEREST_NVIDIA_VFX_RUNTIME_DIR}"
                                 "${CMAKE_SOURCE_DIR}/dev/windows/nvidia-vfx/runtime-lock.json")
  else()
    message(STATUS "TIGEREST_NVIDIA_VFX_RUNTIME_DIR is not set: this package will not include NVIDIA frame generation's runtime")
  endif()
  set(TIGEREST_MPV_RUNTIME_DIR "$ENV{TIGEREST_MPV_RUNTIME_DIR}" CACHE PATH
      "Directory containing both release-pinned RIFE-capable Windows mpv DLLs")
  file(TO_CMAKE_PATH "${TIGEREST_MPV_RUNTIME_DIR}" TIGEREST_MPV_RUNTIME_DIR)
endif(APPLE)

option(CODE_SIGN "code sign the app" OFF)
if(CODE_SIGN)
  set(DO_SIGN 1)
else(CODE_SIGN)
  set(DO_SIGN 0)
endif(CODE_SIGN)

if(ENABLE_ANGLE_DEP)
  set(DO_ENABLE_ANGLE_DEP 1)
else()
  set(DO_ENABLE_ANGLE_DEP 0)
endif()

if(SCRIPT)
  configure_file(${CMAKE_SOURCE_DIR}/CMakeModules/${SCRIPT}.cmake.in ${SCRIPT}.cmake @ONLY)
  install(SCRIPT ${CMAKE_CURRENT_BINARY_DIR}/${SCRIPT}.cmake)
endif(SCRIPT)
