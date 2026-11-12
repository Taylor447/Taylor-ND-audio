add_executable(tnd-recover main.cpp)
target_compile_features(tnd-recover PRIVATE cxx_std_17)
target_compile_definitions(tnd-recover PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(tnd-recover PRIVATE shell32 advapi32)
