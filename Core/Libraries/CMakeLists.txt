# WW common libraries decended from earliest C&C games
add_subdirectory(Source/WWVegas)

# profiling library
add_subdirectory(Source/profile)

# debugging library
add_subdirectory(Source/debug)

add_subdirectory(Source/EABrowserDispatch)
add_subdirectory(Source/EABrowserEngine)
add_subdirectory(Source/Compression)

# Web port: D3D8 -> WebGL2 renderer (Emscripten builds only)
# GeneralsX @build web-port 05/07/2026 - Web port Phase 0
if(SAGE_USE_WEBGL)
    add_subdirectory(Source/d3d8webgl)
endif()
