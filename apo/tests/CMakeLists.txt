add_executable(taylor-apo-harness offline_harness.cpp)
target_compile_features(taylor-apo-harness PRIVATE cxx_std_17)
target_compile_definitions(taylor-apo-harness PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(taylor-apo-harness PRIVATE audioenginebaseapo uuid)
