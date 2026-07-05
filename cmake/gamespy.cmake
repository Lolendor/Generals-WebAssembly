set(GS_OPENSSL FALSE)
set(GAMESPY_SERVER_NAME "server.cnc-online.net")

FetchContent_Declare(
    gamespy
    GIT_REPOSITORY https://github.com/TheAssemblyArmada/GamespySDK.git
    GIT_TAG        07e3d15c500415abc281efb74322ab6d9c857eb8
)

FetchContent_MakeAvailable(gamespy)

# GeneralsX @build web-port 05/07/2026 - Web port Phase 0
# GameSpy's per-platform source ladders key on __linux__/_MACOSX, which
# Emscripten does not define. Its Linux implementations are plain POSIX
# sockets (all present in Emscripten's musl headers; inert at runtime in the
# web build - online services are never used there). Scope the define to the
# GameSpy targets only: defining __linux__ globally would derail SDL3 etc.
if(EMSCRIPTEN)
    function(_gamespy_web_defines dir)
        get_property(_targets DIRECTORY "${dir}" PROPERTY BUILDSYSTEM_TARGETS)
        foreach(_tgt IN LISTS _targets)
            get_target_property(_type ${_tgt} TYPE)
            if(NOT _type STREQUAL "INTERFACE_LIBRARY")
                target_compile_definitions(${_tgt} PRIVATE __linux__ _LINUX)
            endif()
        endforeach()
        get_property(_subdirs DIRECTORY "${dir}" PROPERTY SUBDIRECTORIES)
        foreach(_sub IN LISTS _subdirs)
            _gamespy_web_defines("${_sub}")
        endforeach()
    endfunction()
    _gamespy_web_defines("${gamespy_SOURCE_DIR}")
endif()
