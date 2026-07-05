# Emscripten (WebAssembly) build configuration
# GeneralsX @build web-port 05/07/2026 - Web port Phase 0
#
# Global compile/link flags for the browser build. Included from the root
# CMakeLists.txt right after compilers.cmake so the flags apply to every
# target, including FetchContent dependencies (SDL3, freetype, zlib, ...).
#
# Architecture notes:
# - The game keeps its original blocking main loop (GameEngine::execute()).
#   -sPROXY_TO_PTHREAD runs main() on a dedicated pthread (a Web Worker), so
#   blocking is legal and synchronous OPFS access handles are available for
#   WASMFS file I/O (they only exist in worker contexts).
# - The canvas is transferred to that pthread (OFFSCREENCANVAS) so the
#   d3d8webgl renderer can create its WebGL2 context off the main thread.
# - -fwasm-exceptions: the engine relies on try/catch (GameEngine::execute,
#   INI exceptions); native wasm EH is much faster than the JS-based emulation.

if(NOT EMSCRIPTEN)
    return()
endif()

message(STATUS "Configuring Emscripten (WebAssembly) build")

# The codebase treats every non-Windows platform as "_UNIX" (core_config adds
# it for engine targets); the FetchContent'd GameSpy SDK needs it too, and its
# targets don't link core_config - so define it globally. Emscripten's musl
# provides all the POSIX headers GameSpy's _UNIX branch includes.
add_compile_definitions(_UNIX)

# Compile flags for every translation unit.
add_compile_options(
    -pthread
    -fwasm-exceptions
    # The 2003 codebase trips these on purpose in a few places; keep the build log usable.
    -Wno-deprecated-declarations
    -Wno-deprecated-non-prototype
)

# Link flags for executables. Harmless for static archives (ignored).
add_link_options(
    -pthread
    -fwasm-exceptions
    # Main loop runs blocking on a worker; sync OPFS + usleep() become legal.
    "SHELL:-s PROXY_TO_PTHREAD"
    "SHELL:-s PTHREAD_POOL_SIZE=8"
    # Memory: assets stay in OPFS (not in the heap); the engine itself wants
    # several hundred MB. wasm32 caps at 4GB.
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=768MB"
    "SHELL:-s MAXIMUM_MEMORY=4GB"
    "SHELL:-s STACK_SIZE=4MB"
    # Modern FS: required for the OPFS backend (wasmfs_create_opfs_backend).
    "SHELL:-s WASMFS"
    # WebGL2 context created from the game pthread via OffscreenCanvas.
    "SHELL:-s OFFSCREENCANVAS_SUPPORT=1"
    "SHELL:-s OFFSCREENCANVASES_TO_PTHREAD=#canvas"
    "SHELL:-s MAX_WEBGL_VERSION=2"
    "SHELL:-s MIN_WEBGL_VERSION=2"
    "SHELL:-s FULL_ES3=1"
    # Emscripten's built-in OpenAL (WebAudio backend).
    -lopenal
    "SHELL:-s ENVIRONMENT=web,worker"
    # The wasm is served next to the page by the Go server.
    "SHELL:-s EXPORTED_RUNTIME_METHODS=ccall,cwrap,callMain"
)

if(RTS_BUILD_OPTION_DEBUG)
    add_link_options(
        "SHELL:-s ASSERTIONS=2"
        -gsource-map
    )
else()
    # Keep DWARF names out of release wasm but leave function names for stack traces.
    add_link_options(--profiling-funcs)
endif()

# find_package must not wander into the macOS host system (Homebrew etc.).
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

# ---------------------------------------------------------------------------
# Header-only math dependencies (vcpkg provides these on the other platforms;
# there is no vcpkg toolchain for wasm32 here, so fetch them directly).
# Versions match the vcpkg baseline used by the native builds.
# ---------------------------------------------------------------------------
include(FetchContent)

if(NOT TARGET glm::glm)
    message(STATUS "Emscripten: fetching glm (header-only)")
    FetchContent_Declare(
        glm
        URL https://github.com/g-truc/glm/archive/refs/tags/1.0.1.tar.gz
        URL_HASH SHA256=9f3174561fd26904b23f0db5e560971cbf9b3cbda0b280f04d5c379d03bf234c
    )
    set(GLM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(glm)
endif()

if(NOT TARGET gli)
    message(STATUS "Emscripten: fetching gli (header-only)")
    FetchContent_Declare(
        gli
        GIT_REPOSITORY https://github.com/g-truc/gli.git
        GIT_TAG        779b99ac6656e4d30c3b24e96e0136a59649a869
    )
    FetchContent_Populate(gli)
    add_library(gli INTERFACE)
    target_include_directories(gli INTERFACE ${gli_SOURCE_DIR})
endif()

# ---------------------------------------------------------------------------
# FreeType: WW3D2 text rendering uses it on every non-Windows platform.
# Fonts ship in the asset pack (like the iOS bundle's fonts/ dir); fontconfig
# is not used on the web.
# ---------------------------------------------------------------------------
if(NOT TARGET Freetype::Freetype AND NOT TARGET freetype)
    message(STATUS "Emscripten: fetching FreeType")
    FetchContent_Declare(
        freetype
        URL https://gitlab.freedesktop.org/freetype/freetype/-/archive/VER-2-13-3/freetype-VER-2-13-3.tar.gz
    )
    set(FT_DISABLE_ZLIB     ON CACHE BOOL "" FORCE)  # uses the vendored copy instead
    set(FT_DISABLE_BZIP2    ON CACHE BOOL "" FORCE)
    set(FT_DISABLE_PNG      ON CACHE BOOL "" FORCE)
    set(FT_DISABLE_HARFBUZZ ON CACHE BOOL "" FORCE)
    set(FT_DISABLE_BROTLI   ON CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(freetype)
endif()
if(TARGET freetype AND NOT TARGET Freetype::Freetype)
    add_library(Freetype::Freetype ALIAS freetype)
endif()
