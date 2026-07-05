# d3d8webgl - D3D8 -> WebGL2 renderer for the Emscripten web port
# GeneralsX @build web-port 05/07/2026 - Web port Phase 0
#
# Implements the subset of the Direct3D 8 API the engine uses (see
# WW3D2/dx8wrapper.cpp) on top of WebGL2. Statically linked; DX8Wrapper::Init()
# calls ::Direct3DCreate8() directly on Emscripten instead of dlopen'ing DXVK.
#
# Phase 0 ships a NULL DEVICE: every call succeeds, Lock* returns real backing
# memory, nothing is rendered. This lets the whole engine link and run headless.
# Phase 2 replaces the null internals with the WebGL2 pipeline.

add_library(d3d8webgl STATIC
    src/d3d8webgl.cpp
)

# D3D8 headers come from the DXVK checkout (headers only on Emscripten);
# included directly instead of via d3d8lib to avoid a target cycle
# (CompatLib links d3d8webgl INTO d3d8lib). WWLib provides bittype.h, which
# CompatLib's windows.h wrapper pulls in (the wrapper shadows DXVK's windows.h
# through the global include dir - same header environment as engine TUs, so
# the COM vtable layouts match).
target_include_directories(d3d8webgl PRIVATE
    ${dxvk_SOURCE_DIR}/include/native
    ${dxvk_SOURCE_DIR}/include/native/windows
    ${dxvk_SOURCE_DIR}/include/native/directx
    ${CMAKE_SOURCE_DIR}/Core/Libraries/Source/WWVegas/WWLib
)

target_compile_features(d3d8webgl PRIVATE cxx_std_20)
