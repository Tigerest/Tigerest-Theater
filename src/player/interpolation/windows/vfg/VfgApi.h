// Minimal declarations for the NVIDIA Video Effects SDK 1.3.0 C API
// (NVVideoEffects.dll and NVCVImage.dll), written from NVIDIA's public API
// reference and the MIT-licensed VFX-SDK-Samples. No SDK header or import
// library is used: the runtime is located and loaded when the program runs.
#pragma once
#include <windows.h>
#include <stdexcept>
#include <string>

namespace vfg {

using Status = int;                                  // NvCV_Status, 0 is NVCV_SUCCESS
using CudaStream = struct CudaStreamOpaque*;         // CUstream
using Effect = struct EffectOpaque*;                 // NvVFX_Handle

enum : int { FormatRGBA = 6, FormatBGRA = 7 };       // NvCVImage_PixelFormat
enum : int { TypeU8 = 1, TypeP32 = 11 };             // NvCVImage_ComponentType
enum : unsigned { LayoutChunky = 0 };
enum : unsigned { MemCpu = 0, MemGpu = 1, MemCpuPinned = 2 };

struct Image {                                       // NvCVImage
    unsigned width = 0, height = 0, pitch = 0;
    int pixelFormat = 0, componentType = 0;
    unsigned char pixelBytes = 0, componentBytes = 0, numComponents = 0, planar = 0;
    unsigned char gpuMem = 0, colorspace = 0, reserved[2] = {};
    void* pixels = nullptr;
    void* deletePtr = nullptr;
    void (*deleteProc)(void*) = nullptr;
    unsigned long long bufferBytes = 0;
};
static_assert(sizeof(Image) == 64, "NvCVImage layout");

// Selector strings, confirmed against the strings in the 1.3.0 feature DLL.
inline constexpr const char* kEffect = "VideoFrameGeneration";
inline constexpr const char* kInputWidth = "InputWidth";
inline constexpr const char* kInputHeight = "InputHeight";
inline constexpr const char* kMode = "Mode";                       // 0 low, 1 medium, 2 high
inline constexpr const char* kCudaStream = "CudaStream";
inline constexpr const char* kPrevious = "SrcImage0";
inline constexpr const char* kCurrent = "SrcImage1";
inline constexpr const char* kOutput = "DstImage0";
inline constexpr const char* kFrameMultiplier = "FrameMultiplier"; // 0 selects timestep mode
inline constexpr const char* kTimestep = "Timestep";
inline constexpr const char* kShotChange = "ShotChange";
inline constexpr const char* kAutoShotChange = "AutomaticShotChangeDetectionEnabled";

struct Api {
    HMODULE effects = nullptr, image = nullptr, cudart = nullptr;
    DLL_DIRECTORY_COOKIE searchDirectory = nullptr;                    // from AddDllDirectory, see releaseDirectory()
    Status (*GetVersion)(unsigned*) = nullptr;
    Status (*CreateEffect)(const char*, Effect*) = nullptr;
    void (*DestroyEffect)(Effect) = nullptr;
    Status (*SetU32)(Effect, const char*, unsigned) = nullptr;
    Status (*SetF32)(Effect, const char*, float) = nullptr;
    Status (*SetImage)(Effect, const char*, Image*) = nullptr;
    Status (*SetCudaStream)(Effect, const char*, CudaStream) = nullptr;
    Status (*Load)(Effect) = nullptr;
    Status (*Run)(Effect, int) = nullptr;
    Status (*CudaStreamCreate)(CudaStream*) = nullptr;
    void (*CudaStreamDestroy)(CudaStream) = nullptr;
    Status (*CudaStreamSynchronize)(CudaStream) = nullptr;         // optional
    Status (*ImageAlloc)(Image*, unsigned, unsigned, int, int, unsigned, unsigned, unsigned) = nullptr;
    void (*ImageDealloc)(Image*) = nullptr;
    Status (*ImageInit)(Image*, unsigned, unsigned, unsigned, void*, int, int, unsigned, unsigned) = nullptr;
    Status (*ImageTransfer)(const Image*, Image*, float, CudaStream, Image*) = nullptr;
    const char* (*ErrorString)(Status) = nullptr;                  // optional
    int (*CudaMemGetInfo)(size_t*, size_t*) = nullptr;             // optional, from cudart

    // Loads the runtime from one private directory. Dependencies resolve from
    // that directory and System32 only, never from PATH.
    void load(const std::wstring& directory) {
        const DWORD flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS;
        searchDirectory = AddDllDirectory(directory.c_str());
        if (!searchDirectory) throw std::runtime_error("AddDllDirectory failed");
        auto open = [&](const wchar_t* name, bool required) {
            const HMODULE module = LoadLibraryExW((directory + L"\\" + name).c_str(), nullptr, flags);
            if (!module && required)
                throw std::runtime_error("Cannot load a VFG runtime DLL, Windows error " + std::to_string(GetLastError()));
            return module;
        };
        image = open(L"NVCVImage.dll", true);
        effects = open(L"NVVideoEffects.dll", true);
        cudart = open(L"cudart64_12.dll", false);
        bind(effects, "NvVFX_GetVersion", GetVersion);
        bind(effects, "NvVFX_CreateEffect", CreateEffect);
        bind(effects, "NvVFX_DestroyEffect", DestroyEffect);
        bind(effects, "NvVFX_SetU32", SetU32);
        bind(effects, "NvVFX_SetF32", SetF32);
        bind(effects, "NvVFX_SetImage", SetImage);
        bind(effects, "NvVFX_SetCudaStream", SetCudaStream);
        bind(effects, "NvVFX_Load", Load);
        bind(effects, "NvVFX_Run", Run);
        bind(effects, "NvVFX_CudaStreamCreate", CudaStreamCreate);
        bind(effects, "NvVFX_CudaStreamDestroy", CudaStreamDestroy);
        bind(effects, "NvVFX_CudaStreamSynchronize", CudaStreamSynchronize, false);
        bind(image, "NvCVImage_Alloc", ImageAlloc);
        bind(image, "NvCVImage_Dealloc", ImageDealloc);
        bind(image, "NvCVImage_Init", ImageInit);
        bind(image, "NvCVImage_Transfer", ImageTransfer);
        bind(image, "NvCV_GetErrorStringFromCode", ErrorString, false);
        if (cudart) bind(cudart, "cudaMemGetInfo", CudaMemGetInfo, false);
    }

    // A host that reloads this binding many times (a VapourSynth plugin is
    // unloaded with its core) drops the search directory again once the effect
    // is destroyed. The runtime DLLs themselves stay loaded.
    void releaseDirectory() {
        if (searchDirectory) RemoveDllDirectory(searchDirectory);
        searchDirectory = nullptr;
    }

    void check(Status status, const char* what) const {
        if (status == 0) return;
        std::string message = std::string(what) + " failed with NvCV status " + std::to_string(status);
        if (ErrorString) if (const char* text = ErrorString(status)) message += std::string(" (") + text + ")";
        throw std::runtime_error(message);
    }

private:
    template <typename Function>
    static void bind(HMODULE module, const char* name, Function& target, bool required = true) {
        target = reinterpret_cast<Function>(GetProcAddress(module, name));
        if (!target && required) throw std::runtime_error(std::string("Missing VFG runtime export ") + name);
    }
};

}  // namespace vfg
