# FFmpeg for Emscripten (WebAssembly) - Web port
# GeneralsX @build web-port 05/07/2026 - Web port Phase 0/4
#
# The engine uses FFmpeg for two things on non-Windows platforms:
#   - audio decode (OpenALAudioCache pulls FFmpegFile even with video off)
#   - Bink video playback (FFmpegVideoPlayer, RTS_HAS_FFMPEG)
# There is no vcpkg for wasm32, so build a minimal FFmpeg from source with the
# Emscripten toolchain: only the decoders/demuxers the game data needs
# (WAV/MP3 audio, Bink video), no asm, no threads (the game decodes on its own
# pthread; ffmpeg-internal threading is unnecessary and pthreads-in-ffmpeg
# complicates the worker pool).
#
# IMPORTANT: every object linked into a -pthread wasm module must be compiled
# with -pthread (shared memory ABI), hence the extra-cflags.
#
# Exposes the GLOBAL imported target PkgConfig::FFMPEG (same name the
# pkg-config path creates on the other platforms) so GameEngineDevice's link
# lines work unchanged.

if(NOT EMSCRIPTEN)
    return()
endif()

if(TARGET PkgConfig::FFMPEG)
    return()
endif()

include(ExternalProject)

set(FFMPEG_EM_VERSION "7.1")
set(FFMPEG_EM_PREFIX "${CMAKE_BINARY_DIR}/_deps/ffmpeg-emscripten")
set(FFMPEG_EM_INSTALL "${FFMPEG_EM_PREFIX}/install")

# emconfigure/emmake live next to emcc (EMSCRIPTEN_ROOT_PATH comes from the
# toolchain file).
if(NOT EMSCRIPTEN_ROOT_PATH)
    get_filename_component(EMSCRIPTEN_ROOT_PATH "${CMAKE_TOOLCHAIN_FILE}/../../.." ABSOLUTE)
endif()

set(FFMPEG_EM_LIBS
    "${FFMPEG_EM_INSTALL}/lib/libavformat.a"
    "${FFMPEG_EM_INSTALL}/lib/libavcodec.a"
    "${FFMPEG_EM_INSTALL}/lib/libswscale.a"
    "${FFMPEG_EM_INSTALL}/lib/libswresample.a"
    "${FFMPEG_EM_INSTALL}/lib/libavutil.a"
)

ExternalProject_Add(ffmpeg_emscripten_build
    URL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_EM_VERSION}.tar.xz
    PREFIX ${FFMPEG_EM_PREFIX}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    CONFIGURE_COMMAND
        ${EMSCRIPTEN_ROOT_PATH}/emconfigure <SOURCE_DIR>/configure
            --prefix=${FFMPEG_EM_INSTALL}
            --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib
            --target-os=none --arch=x86_32 --enable-cross-compile
            --disable-asm --disable-x86asm --disable-inline-asm --disable-stripping
            --disable-programs --disable-doc --disable-debug
            --disable-avdevice --disable-avfilter --disable-postproc --disable-network
            --disable-pthreads --disable-w32threads --disable-os2threads
            --disable-everything
            --enable-avcodec --enable-avformat --enable-swscale --enable-swresample
            --enable-decoder=bink,binkaudio_dct,binkaudio_rdft,mp3,mp3float,pcm_s16le,pcm_u8,pcm_s8,pcm_s16be,pcm_s24le,pcm_f32le,pcm_alaw,pcm_mulaw,adpcm_ms,adpcm_ima_wav
            --enable-demuxer=bink,mp3,wav
            --enable-parser=mpegaudio
            --enable-protocol=file
            "--extra-cflags=-pthread -O2"
    BUILD_COMMAND ${EMSCRIPTEN_ROOT_PATH}/emmake make -j8
    INSTALL_COMMAND ${EMSCRIPTEN_ROOT_PATH}/emmake make install
    BUILD_BYPRODUCTS ${FFMPEG_EM_LIBS}
    BUILD_IN_SOURCE FALSE
)

# The include dir must exist at configure time for INTERFACE_INCLUDE_DIRECTORIES.
file(MAKE_DIRECTORY "${FFMPEG_EM_INSTALL}/include")

add_library(PkgConfig::FFMPEG INTERFACE IMPORTED GLOBAL)
set_target_properties(PkgConfig::FFMPEG PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_EM_INSTALL}/include"
    INTERFACE_LINK_LIBRARIES "${FFMPEG_EM_LIBS}"
)
add_dependencies(PkgConfig::FFMPEG ffmpeg_emscripten_build)

message(STATUS "FFmpeg ${FFMPEG_EM_VERSION} (Emscripten, minimal WAV/MP3/Bink) configured via ExternalProject")
