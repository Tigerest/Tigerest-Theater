#include "RifeVSScriptRuntime.h"
#include <QDir>
#include <QFileInfo>
#include <windows.h>
#include <cstdlib>
#include <vector>

namespace rife {
namespace {
struct RuntimeState {
    QString pinnedRoot;
    std::vector<DLL_DIRECTORY_COOKIE> directories;
    HMODULE pythonLibrary=nullptr;
};
RuntimeState& runtimeState(){static RuntimeState state;return state;}
QString modulePath(HMODULE module){
    wchar_t buffer[32768]{};
    if(!GetModuleFileNameW(module,buffer,DWORD(std::size(buffer))))return {};
    return QFileInfo(QString::fromWCharArray(buffer)).canonicalFilePath();
}
}
bool validateVSScriptRuntime(const QString& verifiedRoot,QString* error){
    if(error)error->clear();
    const auto root=QFileInfo(verifiedRoot).canonicalFilePath();
    if(root.isEmpty()||runtimeState().pinnedRoot.isEmpty()||
       root.compare(runtimeState().pinnedRoot,Qt::CaseInsensitive)!=0){
        if(error)*error="Private runtime must be activated before mpv_create; restart the player";
        return false;
    }
    return true;
}
bool activateVSScriptRuntime(const QString& verifiedRoot,QString* error){
    // Called on the player's Qt thread. Keep DLL search cookies for the whole
    // process: mpv may rebuild its VS graph later on a decoder thread.
    auto& state=runtimeState();
    auto fail=[&](const QString& message){if(error)*error=message;return false;};
    if(error)error->clear();
    const auto root=QFileInfo(verifiedRoot).canonicalFilePath();
    if(root.isEmpty()||!QFileInfo(root).isDir())return fail("Private runtime directory is missing");
    if(!state.pinnedRoot.isEmpty())return validateVSScriptRuntime(root,error);
    const auto python=root+"/python",vs=python+"/Lib/site-packages/vapoursynth";
    const std::pair<const wchar_t*,QString> modules[]={{L"python3.dll",python+"/python3.dll"},
        {L"python313.dll",python+"/python313.dll"},{L"vsscript.dll",vs+"/vsscript.dll"},{L"libvapoursynth.dll",vs+"/libvapoursynth.dll"}};
    for(const auto& entry:modules){
        if(!QFileInfo(entry.second).isFile())return fail("Private runtime DLL is missing");
        if(const auto loaded=GetModuleHandleW(entry.first))
            if(modulePath(loaded).compare(QFileInfo(entry.second).canonicalFilePath(),Qt::CaseInsensitive)!=0)
                return fail("Another Python or VapourSynth runtime is already loaded; restart the player");
    }
    if(!QFileInfo(python+"/python.exe").isFile()||!QFileInfo(python+"/python313._pth").isFile())
        return fail("Private isolated Python configuration is missing");
    std::vector<DLL_DIRECTORY_COOKIE> added;
    for(const auto& path:{python,vs,root+"/plugins",root+"/plugins/vsmlrt-cuda"}){
        // The runtime bundled with the player has Python and VapourSynth only.
        if(path.startsWith(root+"/plugins")&&!QFileInfo(path).isDir())continue;
        const auto cookie=AddDllDirectory(path.toStdWString().c_str());
        if(!cookie){for(const auto previous:added)RemoveDllDirectory(previous);return fail("Cannot register private DLL directories");}
        added.push_back(cookie);
    }
    const auto library=LoadLibraryExW((python+"/python313.dll").toStdWString().c_str(),nullptr,
                                     LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    const auto initialized=library?reinterpret_cast<int(*)()>(GetProcAddress(library,"Py_IsInitialized")):nullptr;
    bool configured=initialized&&initialized()==0;
    for(const auto* name:{"Py_DontWriteBytecodeFlag","Py_IgnoreEnvironmentFlag","Py_NoSiteFlag","Py_IsolatedFlag"}){
        auto* flag=library?reinterpret_cast<int*>(GetProcAddress(library,name)):nullptr;
        if(!flag)configured=false;
        else if(configured)*flag=1;
    }
    if(!configured){
        if(library)FreeLibrary(library);
        for(const auto cookie:added)RemoveDllDirectory(cookie);
        return fail("Private Python cannot be configured before initialization; restart the player");
    }
    // R79 finds python.exe/python3.dll directly four directories above this
    // portable VSScript DLL. CPython's verified _pth ignores environment,
    // registry and site discovery; no user configuration file is written.
    // qputenv uses the narrow Windows CRT API, which cannot store every UTF-8
    // path under the active ANSI code page. Update the wide CRT/environment.
    if(_wputenv_s(L"VSSCRIPT_PATH",QFileInfo(vs+"/vsscript.dll").canonicalFilePath().toStdWString().c_str())!=0){
        FreeLibrary(library);
        for(const auto cookie:added)RemoveDllDirectory(cookie);
        return fail("Cannot set the private VSScript path");
    }
    // R79 uses legacy Py_InitializeEx. Its pinned CPython 3.13 exported flags
    // must be set before that call: isolated _pth ignores PYTHONDONTWRITEBYTECODE.
    state.pythonLibrary=library;state.directories=std::move(added);state.pinnedRoot=root;
    return true;
}
QString cudaComputeCapability(){
    static const QString capability=[]{
        const HMODULE cuda=LoadLibraryExW(L"nvcuda.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
        if(!cuda)return QString();
        using Init=int(__stdcall*)(unsigned);
        using DeviceGet=int(__stdcall*)(int*,int);
        using Attribute=int(__stdcall*)(int*,int,int);
        const auto init=reinterpret_cast<Init>(GetProcAddress(cuda,"cuInit"));
        const auto deviceGet=reinterpret_cast<DeviceGet>(GetProcAddress(cuda,"cuDeviceGet"));
        const auto attribute=reinterpret_cast<Attribute>(GetProcAddress(cuda,"cuDeviceGetAttribute"));
        // CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR and _MINOR.
        int device=0,major=0,minor=0;
        if(init&&deviceGet&&attribute&&init(0)==0&&deviceGet(&device,0)==0&&
           attribute(&major,75,device)==0&&attribute(&minor,76,device)==0)
            return QStringLiteral("%1.%2").arg(major).arg(minor);
        return QString();
    }();
    return capability;
}
}
