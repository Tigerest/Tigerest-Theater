#!/usr/bin/env python3
"""Generate the deterministic Xcode project without a package-manager dependency."""
import hashlib, plistlib, json, subprocess, os
from pathlib import Path
from sync_resources import sync
ROOT = Path(__file__).resolve().parents[1]
objects = {}
def obj(key, isa, **fields):
    ident=hashlib.sha256(key.encode()).hexdigest()[:24].upper()
    objects[ident]={'isa':isa,**fields};return ident
def file(path, kind):
    return obj(path,'PBXFileReference',lastKnownFileType=kind,path=path,sourceTree='<group>')
def configurations(name, settings):
    configs=[]
    for mode in ['Debug','Release']:
        configs.append(obj(name+mode,'XCBuildConfiguration',name=mode,**({'baseConfigurationReference':file('Local.xcconfig','text.xcconfig')} if name != 'project' else {}),buildSettings={**settings,'ONLY_ACTIVE_ARCH':'YES' if mode=='Debug' else 'NO','SWIFT_OPTIMIZATION_LEVEL':'-Onone' if mode=='Debug' else '-O', **({'SWIFT_ACTIVE_COMPILATION_CONDITIONS':settings.get('SWIFT_ACTIVE_COMPILATION_CONDITIONS','')+' DEBUG'} if mode=='Debug' else {}), **({'GCC_PREPROCESSOR_DEFINITIONS':'$(inherited) TIGEREST_RIFE_TIMING=1'} if mode=='Debug' and name=='app' else {})}))
    return obj(name+'config','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
def generate():
    existing=ROOT/'TigerestTheater.xcodeproj/project.pbxproj'
    local=ROOT/'Local.xcconfig'
    if existing.exists():
        result=subprocess.run(['plutil','-convert','json','-o','-',str(existing)],capture_output=True)
        if result.returncode == 0:
            previous=json.loads(result.stdout)
            teams={x.get('buildSettings',{}).get('DEVELOPMENT_TEAM') for x in previous.get('objects',{}).values()}-{None,''}
            if len(teams)==1:local.write_text('// Local signing identity; never commit.\nDEVELOPMENT_TEAM = '+teams.pop()+'\n')
    if not local.exists():local.write_text('// Select Personal Team in Xcode, or pass --team to build.py.\n')
    sync(ROOT/'Generated/Web')
    sources=[];files=[]
    for path in sorted((ROOT/'App').rglob('*.swift')):
        relative=str(path.relative_to(ROOT));ref=file(relative,'sourcecode.swift');files.append(ref)
        sources.append(obj(relative+'build','PBXBuildFile',fileRef=ref))
    assets=file('Generated/Web','folder');files.append(assets)
    resource=obj('web-res','PBXBuildFile',fileRef=assets)
    product=obj('product','PBXFileReference',explicitFileType='wrapper.application',path='TigerestTheater.app',sourceTree='BUILT_PRODUCTS_DIR')
    core=obj('core','XCLocalSwiftPackageReference',relativePath='Core')
    corelib=obj('corelib','XCSwiftPackageProductDependency',productName='AppleCore',package=core)
    packages=[core];libs=[corelib]
    # Resolve the fixed upstream commit once playback sources are present.
    if (ROOT/'App/Playback/MPVEngine.swift').exists():
        mpv=obj('mpv','XCRemoteSwiftPackageReference',repositoryURL='https://github.com/mpvkit/MPVKit.git',requirement={'kind':'revision','revision':'d9194243bdc68b87d8989376ab52aee7da6c8e0b'})
        packages.append(mpv);libs.append(obj('mpvlib','XCSwiftPackageProductDependency',productName='MPVKit',package=mpv))
    native_rife=(ROOT/'Generated/NativeRIFE/source.json').exists()
    resources=[resource]
    ref=file('Resources/SubtitleFonts','folder');files.append(ref)
    resources.append(obj('ipad-subtitle-fonts-resource','PBXBuildFile',fileRef=ref))
    ref=file('Resources/iPad.xcassets','folder.assetcatalog');files.append(ref)
    resources.append(obj('ipad-icons-resource','PBXBuildFile',fileRef=ref))
    ref=file('Config/PrivacyInfo.xcprivacy','text.xml');files.append(ref)
    resources.append(obj('ipad-privacy-resource','PBXBuildFile',fileRef=ref))
    if native_rife:
        native_sources=[*sorted((ROOT/'NativeRIFE').glob('*.c')),*sorted((ROOT/'NativeRIFE').glob('*.mm')),ROOT/'Generated/NativeRIFE/user_filters.c',*[ROOT.parent/'src/player/interpolation'/f'{name}.mm' for name in ['RifeEngine','RifeMetalWarp','RifeCoarseMetal']]]
        for path in native_sources:
            relative=os.path.relpath(path,ROOT)
            ref=file(relative,'sourcecode.c.c' if path.suffix=='.c' else 'sourcecode.cpp.objcpp');files.append(ref);sources.append(obj(relative+'build','PBXBuildFile',fileRef=ref))
        ref=file('Generated/RifeModel','folder');files.append(ref);resources.append(obj('rife-model-resource','PBXBuildFile',fileRef=ref))
    phases=[obj('srcphase' ,'PBXSourcesBuildPhase',buildActionMask=2147483647,files=sources,runOnlyForDeploymentPostprocessing=0),obj('resphase','PBXResourcesBuildPhase',buildActionMask=2147483647,files=resources,runOnlyForDeploymentPostprocessing=0),obj('frameworkphase','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[obj(x+'link','PBXBuildFile',productRef=x) for x in libs],runOnlyForDeploymentPostprocessing=0)]
    settings={'PRODUCT_NAME':'TigerestTheater','PRODUCT_BUNDLE_IDENTIFIER':'top.tigerest.theater.universal','INFOPLIST_FILE':'Config/Info.plist','SWIFT_VERSION':'5.0','IPHONEOS_DEPLOYMENT_TARGET':'26.0','TARGETED_DEVICE_FAMILY':'1,2','TIGEREST_DISTRIBUTION':'github','CODE_SIGN_STYLE':'Automatic','SDKROOT':'iphoneos','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','CLANG_ENABLE_MODULES':'YES','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/Frameworks','ENABLE_USER_SCRIPT_SANDBOXING':'YES','GENERATE_INFOPLIST_FILE':'NO'}
    if native_rife:
        include=['$(inherited)','$(SRCROOT)/Generated/NativeRIFE','$(SRCROOT)/Generated/NativeRIFE/mpv','$(SRCROOT)/Generated/NativeRIFE/mpv/filters','$(SRCROOT)/NativeRIFE','$(SRCROOT)/../src/player/interpolation']
        settings.update({'HEADER_SEARCH_PATHS':include,'HEADER_SEARCH_PATHS[sdk=iphoneos*]':include+['$(SRCROOT)/Generated/NativeRIFE/device'],'HEADER_SEARCH_PATHS[sdk=iphonesimulator*]':include+['$(SRCROOT)/Generated/NativeRIFE/simulator'],'CLANG_CXX_LANGUAGE_STANDARD':'c++17','CLANG_ENABLE_OBJC_ARC':'YES','GCC_C_LANGUAGE_STANDARD':'gnu11','OTHER_LDFLAGS':'$(inherited) -framework CoreML -framework Metal','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'$(inherited) RIFE_NATIVE'})
    target=obj('app' ,'PBXNativeTarget',name='TigerestTheater',productName='TigerestTheater',productReference=product,productType='com.apple.product-type.application',buildConfigurationList=configurations('app',{**settings,'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon'}),buildPhases=phases,buildRules=[],dependencies=[],packageProductDependencies=libs)
    testFiles=[]
    for path in sorted((ROOT/'UITests').glob('*.swift')):
        relative=str(path.relative_to(ROOT));ref=file(relative,'sourcecode.swift');files.append(ref);testFiles.append(obj(relative+'build','PBXBuildFile',fileRef=ref))
    # Device tests also run AppleCore logic (release feed signatures) with the desktop fixtures.
    testCore=obj('testcorelib','XCSwiftPackageProductDependency',productName='AppleCore',package=core)
    testResources=[]
    for name in ['release_feed_cases.json','release_feed_production.json']:
        ref=file('../tests/fixtures/'+name,'text.json');files.append(ref);testResources.append(obj(name+'testbuild','PBXBuildFile',fileRef=ref))
    testProduct=obj('testproduct','PBXFileReference',explicitFileType='wrapper.cfbundle',path='TigerestUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR')
    projectID=hashlib.sha256(b'project').hexdigest()[:24].upper()
    proxy=obj('proxy','PBXContainerItemProxy',containerPortal=projectID,proxyType=1,remoteGlobalIDString=target,remoteInfo='TigerestTheater')
    dependency=obj('testdepend','PBXTargetDependency',target=target,targetProxy=proxy)
    testTarget=obj('uitests','PBXNativeTarget',name='TigerestUITests',productName='TigerestUITests',productReference=testProduct,productType='com.apple.product-type.bundle.ui-testing',buildConfigurationList=configurations('tests',{**settings,'PRODUCT_NAME':'TigerestUITests','PRODUCT_BUNDLE_IDENTIFIER':'top.tigerest.theater.universal.uitests','GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_FILE':'','TEST_TARGET_NAME':'TigerestTheater'}),buildPhases=[obj('testphase','PBXSourcesBuildPhase',buildActionMask=2147483647,files=testFiles,runOnlyForDeploymentPostprocessing=0),obj('testframeworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[obj('testcorelink','PBXBuildFile',productRef=testCore)],runOnlyForDeploymentPostprocessing=0),obj('testresources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=testResources,runOnlyForDeploymentPostprocessing=0)],dependencies=[dependency],buildRules=[],packageProductDependencies=[testCore])
    products=obj('products','PBXGroup',name='Products',children=[product,testProduct],sourceTree='<group>')
    main=obj('main','PBXGroup',children=files+[products],sourceTree='<group>')
    obj('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700','TargetAttributes':{target:{'CreatedOnToolsVersion':'27.2'},testTarget:{'CreatedOnToolsVersion':'27.2','TestTargetID':target}}},buildConfigurationList=configurations('project',{'CLANG_ENABLE_MODULES':'YES'}),compatibilityVersion='Xcode 14.0',developmentRegion='zh-Hans',knownRegions=['en','zh-Hans','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=[target,testTarget],packageReferences=packages)
    project=ROOT/'TigerestTheater.xcodeproj';project.mkdir(exist_ok=True)
    (project/'project.pbxproj').write_bytes(plistlib.dumps({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':projectID},sort_keys=False))
    schemes=project/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
    def ref(ident,name,product):return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident}" BuildableName="{product}" BlueprintName="{name}" ReferencedContainer="container:TigerestTheater.xcodeproj"/>'
    app=ref(target,'TigerestTheater','TigerestTheater.app');test=ref(testTarget,'TigerestUITests','TigerestUITests.xctest')
    (schemes/'TigerestTheater.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES" enableGPUValidationMode="0"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>''')
if __name__=='__main__':generate()
