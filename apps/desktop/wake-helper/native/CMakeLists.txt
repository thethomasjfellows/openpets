cmake_minimum_required(VERSION 3.20)
project(openpets_wake_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

foreach(required_var
    OPENPETS_SHERPA_ONNX_ROOT
    OPENPETS_SENTENCEPIECE_SOURCE
    OPENPETS_NLOHMANN_JSON_INCLUDE)
  if(NOT DEFINED ${required_var})
    message(FATAL_ERROR "${required_var} is required")
  endif()
endforeach()

set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
set(SPM_BUILD_TEST OFF CACHE BOOL "" FORCE)
add_subdirectory(
  "${OPENPETS_SENTENCEPIECE_SOURCE}"
  "${CMAKE_CURRENT_BINARY_DIR}/sentencepiece"
  EXCLUDE_FROM_ALL
)

find_path(
  SHERPA_ONNX_INCLUDE_DIR
  NAMES sherpa-onnx/c-api/c-api.h
  PATHS "${OPENPETS_SHERPA_ONNX_ROOT}/include"
  NO_DEFAULT_PATH
  REQUIRED
)
find_library(
  SHERPA_ONNX_C_API_LIBRARY
  NAMES sherpa-onnx-c-api libsherpa-onnx-c-api
  PATHS "${OPENPETS_SHERPA_ONNX_ROOT}/lib"
  NO_DEFAULT_PATH
  REQUIRED
)

add_executable(openpets-wake-helper src/main.cc)
target_include_directories(openpets-wake-helper PRIVATE
  "${SHERPA_ONNX_INCLUDE_DIR}"
  "${OPENPETS_NLOHMANN_JSON_INCLUDE}"
  "${OPENPETS_SENTENCEPIECE_SOURCE}/src"
)
target_link_libraries(openpets-wake-helper PRIVATE
  "${SHERPA_ONNX_C_API_LIBRARY}"
  sentencepiece-static
)

if(APPLE)
  target_link_options(openpets-wake-helper PRIVATE "-Wl,-rpath,@loader_path/../lib")
elseif(UNIX)
  target_link_options(openpets-wake-helper PRIVATE "-Wl,-rpath,\$ORIGIN/../lib")
endif()

if(MSVC)
  target_compile_options(openpets-wake-helper PRIVATE /W4 /EHsc)
else()
  target_compile_options(openpets-wake-helper PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
