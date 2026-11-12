cmake_minimum_required(VERSION 3.24)
project(taylor_apo LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Taylor APO chỉ build bằng MSVC trên Windows x64 với Windows SDK/WDK.")
endif()

add_library(taylor-apo SHARED src/taylor_apo.cpp src/dllmain.cpp)
target_compile_features(taylor-apo PRIVATE cxx_std_17)
target_compile_definitions(taylor-apo PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_include_directories(taylor-apo PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include" "${CMAKE_CURRENT_SOURCE_DIR}/../dsp-core/include")
target_link_libraries(taylor-apo PRIVATE tnd_dsp_core ole32 advapi32 userenv bcrypt ws2_32 ntdll uuid)
set_target_properties(taylor-apo PROPERTIES OUTPUT_NAME "taylor-apo" CXX_EXTENSIONS OFF)

if(NOT TARGET tnd_dsp_core)
  message(FATAL_ERROR "Build tnd-dsp-core trước và truyền đường dẫn thư viện tĩnh qua toolchain CMake.")
endif()
