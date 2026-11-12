add_executable(taylor-configurator main.cpp)
target_compile_features(taylor-configurator PRIVATE cxx_std_17)
target_compile_definitions(taylor-configurator PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(taylor-configurator PRIVATE ole32 propsys shell32 advapi32 uuid)
