/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/*
** WebMain.cpp
**
** Entry point for the Emscripten (WebAssembly) build.
**
** GeneralsX @build web-port 05/07/2026 - Web port Phase 0
** Follows SDL3Main.cpp (the Linux/macOS/iOS entry point) with the platform
** bootstrap swapped for the browser environment:
**  - No Vulkan/DXVK: rendering goes through the statically linked d3d8webgl
**    library (D3D8 -> WebGL2), created by DX8Wrapper::Init() directly.
**  - Game data lives in OPFS (Origin Private File System). The JS loader
**    downloads the .big set into OPFS before starting the wasm module; here
**    we mount that OPFS root at /opfs via WASMFS and point the engine's
**    asset/user-data resolution at it with two environment variables
**    (StdBIGFileSystem reads CNC_GENERALS_ZH_PATH, GlobalData reads
**    XDG_DATA_HOME) - no file-system code changes needed.
**  - main() runs on a dedicated pthread (-sPROXY_TO_PTHREAD), so the engine's
**    blocking GameEngine::execute() loop and synchronous fread() over OPFS
**    access handles are both legal here.
*/

#ifdef __EMSCRIPTEN__

// SYSTEM INCLUDES
#include <SDL3/SDL.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>
#include <unistd.h>   // _exit(), chdir()
#include <sys/stat.h>

// d3d8webgl: native display mode published before device creation.
extern "C" void d3d8webgl_set_native_mode(int w, int h);

// libavutil (FFmpeg): silence swscale's per-open INFO chatter about missing
// SIMD paths - wasm has none by definition. Declared here to avoid pulling
// FFmpeg headers into the entry point; the C ABI is stable.
extern "C" void av_log_set_level(int level);

// USER INCLUDES (match SDL3Main.cpp pattern)
#include "Lib/BaseType.h"
#include "Common/CommandLine.h"
#include "Common/CriticalSection.h"
#include "Common/GlobalData.h"
#include "Common/GameEngine.h"
#include "Common/GameMemory.h"
#include "Common/Debug.h"
#include "Common/version.h"
#include "SDL3GameEngine.h"

// CRITICAL SECTIONS (same set as SDL3Main.cpp)
static CriticalSection critSec1;
static CriticalSection critSec2;
static CriticalSection critSec3;
static CriticalSection critSec4;
static CriticalSection critSec5;

// GLOBAL COMMAND LINE ARGUMENTS (CommandLine.cpp reads these on non-Windows)
int __argc = 0;          ///< global argument count
char** __argv = nullptr; ///< global argument vector

// GLOBAL WINDOW HANDLE (SDL_Window* cast to HWND for engine compatibility)
HWND ApplicationHWnd = nullptr;

// GLOBAL SDL3 WINDOW (SDL3GameEngine reads this)
SDL_Window* TheSDL3Window = nullptr;

// GAME TEXT FILE PATHS (GameText.cpp; lowercase for case-sensitive FS)
const Char *g_csfFile = "data/%s/generals.csf";
const Char *g_strFile = "data/Generals.str";

// Extern declarations (from GameMain.cpp)
extern Int GameMain();

/**
 * CreateGameEngine
 *
 * Factory for the platform engine. The web build reuses SDL3GameEngine -
 * SDL3's Emscripten backend delivers input/window events from the canvas.
 */
GameEngine *CreateGameEngine(void)
{
	fprintf(stderr, "INFO: CreateGameEngine() - Creating SDL3GameEngine for Web\n");
	SDL3GameEngine *engine = NEW SDL3GameEngine();
	return engine;
}

/**
 * PopulateFromIdb
 *
 * IndexedDB fallback (no OPFS in this browser/context): the JS loader has
 * materialized every asset as an ArrayBuffer on window.gxFiles (main thread).
 * Copy them, chunk by chunk through a small wasm-heap buffer, into the
 * js-file-backend mount at /opfs/GameData. File payloads then live in JS
 * memory (NOT the wasm heap), so a 1.5+ GB asset set does not eat the heap.
 *
 * MAIN_THREAD_EM_ASM blocks this pthread while the JS runs on the main
 * thread; the copies via HEAPU8 are plain SharedArrayBuffer writes.
 */
static bool PopulateFromIdb()
{
	const int fileCount = MAIN_THREAD_EM_ASM_INT({
		return (typeof window !== 'undefined' && window.gxFiles) ? window.gxFiles.length : 0;
	});
	if (fileCount == 0) {
		fprintf(stderr, "FATAL: IndexedDB mode but window.gxFiles is empty - loader did not materialize assets\n");
		return false;
	}
	fprintf(stderr, "INFO: populating /opfs/GameData from IndexedDB (%d files)...\n", fileCount);

	const size_t kChunk = 8u * 1024u * 1024u;
	char *chunk = (char *)malloc(kChunk);
	char pathBuf[1024];

	for (int i = 0; i < fileCount; i++) {
		MAIN_THREAD_EM_ASM({
			stringToUTF8(window.gxFiles[$0].path, $1, $2);
		}, i, pathBuf, (int)sizeof(pathBuf));

		const double sizeD = MAIN_THREAD_EM_ASM_DOUBLE({
			return window.gxFiles[$0].data.byteLength;
		}, i);
		const size_t size = (size_t)sizeD;

		// Create intermediate directories under /opfs/GameData. Paths prefixed
		// with GameDataGenerals/ (the optional base-game install) live as an
		// /opfs sibling instead - see gxStoragePath() in storage.js.
		std::string full = (strncmp(pathBuf, "GameDataGenerals/", 17) == 0)
			? std::string("/opfs/") + pathBuf
			: std::string("/opfs/GameData/") + pathBuf;
		for (size_t p = strlen("/opfs/"); p < full.size(); p++) {
			if (full[p] == '/') {
				std::string dir = full.substr(0, p);
				mkdir(dir.c_str(), 0777);
			}
		}

		FILE *fp = fopen(full.c_str(), "wb");
		if (!fp) {
			fprintf(stderr, "FATAL: cannot create %s in js-file backend\n", full.c_str());
			free(chunk);
			return false;
		}
		for (size_t off = 0; off < size; off += kChunk) {
			const size_t n = (size - off) < kChunk ? (size - off) : kChunk;
			MAIN_THREAD_EM_ASM({
				HEAPU8.set(new Uint8Array(window.gxFiles[$0].data, $1, $2), $3);
			}, i, (double)off, (double)n, chunk);
			if (fwrite(chunk, 1, n, fp) != n) {
				fprintf(stderr, "FATAL: short write for %s\n", full.c_str());
				fclose(fp);
				free(chunk);
				return false;
			}
		}
		fclose(fp);

		// Free the JS-side copy as we go to halve peak memory.
		MAIN_THREAD_EM_ASM({ window.gxFiles[$0].data = null; }, i);
	}

	free(chunk);
	MAIN_THREAD_EM_ASM({ window.gxFiles = null; });
	fprintf(stderr, "INFO: IndexedDB population complete\n");
	return true;
}

/**
 * MountGameStorage
 *
 * Mounts persistent storage at /opfs and points the engine's path
 * resolution at it:
 *   /opfs/GameData  - read-only game assets (.big set, Data/, Maps/, fonts/)
 *   /opfs/userdata  - saves, Options.ini, replays (XDG_DATA_HOME branch of
 *                     GlobalData::BuildUserDataPathFromRegistry()).
 *
 * Preferred backend is OPFS (Module.gxStorageMode == 0): the JS loader wrote
 * the files into OPFS before main() started; synchronous access handles work
 * here because -sPROXY_TO_PTHREAD runs main() on a pthread.
 *
 * Fallback (gxStorageMode == 1) is the IndexedDB path: a js-file backend is
 * mounted instead and populated from window.gxFiles (see PopulateFromIdb).
 * Saves are session-local in this mode until Phase 3 adds write-back.
 */
static bool MountGameStorage()
{
	const int mode = MAIN_THREAD_EM_ASM_INT({
		return (typeof Module !== 'undefined' && Module.gxStorageMode) ? Module.gxStorageMode : 0;
	});

	backend_t backend = nullptr;
	if (mode == 0) {
		backend = wasmfs_create_opfs_backend();
		if (backend == nullptr) {
			fprintf(stderr, "FATAL: wasmfs_create_opfs_backend() failed (OPFS unavailable?)\n");
			return false;
		}
	} else {
		backend = wasmfs_create_js_file_backend();
		if (backend == nullptr) {
			fprintf(stderr, "FATAL: wasmfs_create_js_file_backend() failed\n");
			return false;
		}
	}

	int rc = wasmfs_create_directory("/opfs", 0777, backend);
	if (rc != 0) {
		fprintf(stderr, "FATAL: mounting storage at /opfs failed (rc=%d)\n", rc);
		return false;
	}

	if (mode != 0) {
		mkdir("/opfs/GameData", 0777);
		if (!PopulateFromIdb()) {
			return false;
		}
	}

	// Asset root: StdBIGFileSystem::resolvePrimaryAssetDirectory() checks this
	// env var first; everything else (Data/, Maps/) resolves from the CWD.
	setenv("CNC_GENERALS_ZH_PATH", "/opfs/GameData", 1);

	// Base-game assets: ZH only ships the addon's .big set; ground terrain
	// tiles, roads and many W3D models live in the first game's Terrain.big/
	// W3D.big/Textures.big. loadBaseGeneralsAssetsForZH() tries this env var
	// first and silently moves on if the directory has no .big files.
	setenv("CNC_GENERALS_PATH", "/opfs/GameDataGenerals", 1);

	// User data: GlobalData::BuildUserDataPathFromRegistry() Linux/XDG branch
	// yields $XDG_DATA_HOME/GeneralsX/GeneralsZH/.
	setenv("XDG_DATA_HOME", "/opfs/userdata", 1);
	mkdir("/opfs/userdata", 0777); // harmless if the JS loader already made it

	if (chdir("/opfs/GameData") != 0) {
		fprintf(stderr, "WARNING: chdir(/opfs/GameData) failed - assets not downloaded yet?\n");
		return false;
	}

	fprintf(stderr, "INFO: game storage mounted at /opfs (%s; assets: /opfs/GameData, userdata: /opfs/userdata)\n",
	        mode == 0 ? "OPFS" : "IndexedDB via js-file backend");
	return true;
}

/**
 * main
 *
 * Web entry point. Runs on a dedicated pthread (PROXY_TO_PTHREAD).
 */
int main(int argc, char* argv[])
{
	int exitcode = 1;

	__argc = argc;
	__argv = argv;

	fprintf(stderr, "=================================================\n");
	fprintf(stderr, " Command & Conquer Generals: Zero Hour (Web)\n");
	fprintf(stderr, " Emscripten + SDL3 + d3d8webgl Build\n");
	fprintf(stderr, "=================================================\n\n");

	// Mount persistent storage before anything touches the file system (INI,
	// Options.ini, BIG archives are all read during GameMain()).
	if (!MountGameStorage()) {
		fprintf(stderr, "FATAL: game storage mount failed; cannot continue\n");
		return 1;
	}

	try {
		// Initialize critical sections (required by game engine)
		TheAsciiStringCriticalSection = &critSec1;
		TheUnicodeStringCriticalSection = &critSec2;
		TheDmaCriticalSection = &critSec3;
		TheMemoryPoolCriticalSection = &critSec4;
		TheDebugLogCriticalSection = &critSec5;

		// Initialize memory manager early (required by NEW operator)
		initMemoryManager();

		// Version singleton must exist before GameMain() (window title update)
		TheVersion = NEW Version;

		// Parse command line (JS side passes flags via Module.arguments)
		CommandLine::parseCommandLineForStartup();

		const bool isHeadlessMode = (TheGlobalData != nullptr && TheGlobalData->m_headless);
		if (isHeadlessMode) {
			fprintf(stderr, "INFO: Headless mode detected, skipping SDL3 window initialization\n");
		} else {
			fprintf(stderr, "INFO: Initializing SDL3 video subsystem...\n");
			if (!SDL_InitSubSystem(SDL_INIT_VIDEO | SDL_INIT_AUDIO)) {
				fprintf(stderr, "FATAL: Failed to initialize SDL3: %s\n", SDL_GetError());
				return 1;
			}

			// Plain window: no SDL_WINDOW_VULKAN and no SDL_WINDOW_OPENGL.
			// The d3d8webgl renderer creates its own WebGL2 context on the
			// canvas (transferred to this pthread via OFFSCREENCANVAS); SDL
			// only delivers input and window events.
			fprintf(stderr, "INFO: Creating SDL3 window (canvas)...\n");
			TheSDL3Window = SDL_CreateWindow(
				"Command & Conquer Generals: Zero Hour",
				1024, 768,
				SDL_WINDOW_RESIZABLE
			);

			if (!TheSDL3Window) {
				fprintf(stderr, "FATAL: Failed to create SDL3 window: %s\n", SDL_GetError());
				SDL_Quit();
				return 1;
			}

			ApplicationHWnd = (HWND)TheSDL3Window;
			fprintf(stderr, "INFO: SDL3 window created successfully\n");

			// Match the engine's internal resolution to the SDL window/canvas
			// (same pattern as the iOS port): injected as -xres/-yres argv so
			// the normal command-line path applies them unless the user passed
			// explicit values via ?args=.
			{
				bool userSetRes = false;
				for (int i = 1; i < __argc; ++i) {
					if (strcmp(__argv[i], "-xres") == 0 || strcmp(__argv[i], "-yres") == 0) {
						userSetRes = true;
						break;
					}
				}
				int winW = 0, winH = 0;
				SDL_GetWindowSizeInPixels(TheSDL3Window, &winW, &winH);
				// Publish the native mode to d3d8webgl BEFORE the device is
				// created: DX8Wrapper only accepts a 32-bit backbuffer if mode
				// enumeration contains this exact resolution (else the whole
				// game degrades to 16-bit textures).
				d3d8webgl_set_native_mode(winW & ~1, winH & ~1);
				if (!userSetRes && winW >= 640 && winH >= 480) {
					static char xresVal[16], yresVal[16];
					static char xresFlag[] = "-xres";
					static char yresFlag[] = "-yres";
					snprintf(xresVal, sizeof(xresVal), "%d", winW & ~1);
					snprintf(yresVal, sizeof(yresVal), "%d", winH & ~1);
					static char* newArgv[64];
					int n = 0;
					for (int i = 0; i < __argc && n < 59; ++i) {
						newArgv[n++] = __argv[i];
					}
					newArgv[n++] = xresFlag;
					newArgv[n++] = xresVal;
					newArgv[n++] = yresFlag;
					newArgv[n++] = yresVal;
					newArgv[n] = nullptr;
					__argv = newArgv;
					__argc = n;
					fprintf(stderr, "INFO: Web internal resolution set to %sx%s\n", xresVal, yresVal);
				}
			}
		}

		// FFmpeg: errors only (16 = AV_LOG_ERROR). Some video paths create
		// swscale contexts before FFmpegFile::open() runs, so set it here.
		av_log_set_level(16);

		// Call cross-platform game entry point
		exitcode = GameMain();

		// GeneralsX @build web-port 05/07/2026 - Web port Phase 2
		// GameMain() returned with the rAF main loop registered and the
		// engine still alive (see GameEngine::execute web branch). Keep the
		// wasm runtime (and this pthread) alive; NONE of the teardown below
		// may run. Quit terminates from inside the loop tick (_exit).
		fprintf(stderr, "INFO: main loop armed; keeping runtime alive\n");
		emscripten_exit_with_live_runtime();

		fprintf(stderr, "INFO: GameMain() returned with code %d\n", exitcode);

	} catch (const std::exception& e) {
		fprintf(stderr, "FATAL: Unhandled exception in main(): %s\n", e.what());
		exitcode = 1;
	} catch (...) {
		fprintf(stderr, "FATAL: Unknown exception in main()\n");
		exitcode = 1;
	}

	// Cleanup SDL3 resources
	if (TheSDL3Window) {
		SDL_DestroyWindow(TheSDL3Window);
		TheSDL3Window = nullptr;
		ApplicationHWnd = nullptr;
	}
	SDL_Quit();

	if (TheVersion) {
		delete TheVersion;
		TheVersion = nullptr;
	}

	// Same shutdown order as SDL3Main.cpp: memory manager before critSec nulling.
	shutdownMemoryManager();

	TheAsciiStringCriticalSection = nullptr;
	TheUnicodeStringCriticalSection = nullptr;
	TheDmaCriticalSection = nullptr;
	TheMemoryPoolCriticalSection = nullptr;
	TheDebugLogCriticalSection = nullptr;

	fprintf(stderr, "\nExiting with code %d\n", exitcode);

	// Skip C++ global destructors (see SDL3Main.cpp rationale: pool dtors
	// crash after game shutdown reused their memory). Terminates the wasm
	// runtime; the page-side JS shows a "game exited" panel.
	_exit(exitcode);
}

#endif // __EMSCRIPTEN__
