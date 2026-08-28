set(MAIN_TARGET TigerestTheater)

# Output binary name
set(MAIN_NAME tigerest-theater)

# Data directory name - also used for QCoreApplication::applicationName
# which determines QStandardPaths (cache, config, data dirs)
set(DATA_NAME tigerest-theater)

if(APPLE)
  set(MAIN_NAME "Tigerest Theater")
  set(DATA_NAME "Tigerest Theater")
elseif(WIN32)
  set(MAIN_NAME "Tigerest Theater")
  set(DATA_NAME "Tigerest Theater")
endif()

configure_file(src/shared/Names.cpp.in src/shared/Names.cpp @ONLY)
