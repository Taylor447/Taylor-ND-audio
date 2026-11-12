cmake_minimum_required(VERSION 3.24)
project(taylor_nd_audio_stage_c LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Giai đoạn C hiện chỉ cấu hình Windows x64 với MSVC/Windows SDK.")
endif()

set(TND_DSP_CORE_LIB "${CMAKE_CURRENT_SOURCE_DIR}/dsp-core/target/release/tnd_dsp_core.lib" CACHE FILEPATH "Rust static library tnd-dsp-core")
if(NOT EXISTS "${TND_DSP_CORE_LIB}")
  message(FATAL_ERROR "Thiếu ${TND_DSP_CORE_LIB}; chạy scripts/build-stage-c.ps1 trước.")
endif()
add_library(tnd_dsp_core STATIC IMPORTED GLOBAL)
set_target_properties(tnd_dsp_core PROPERTIES IMPORTED_LOCATION "${TND_DSP_CORE_LIB}")

add_subdirectory(apo)
add_subdirectory(configurator)
add_subdirectory(recover)

option(TND_BUILD_HARNESS "Build APO COM offline harness" ON)
if(TND_BUILD_HARNESS)
  add_subdirectory(apo/tests)
endif()
