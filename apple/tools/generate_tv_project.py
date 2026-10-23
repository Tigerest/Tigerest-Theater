#!/usr/bin/env python3
"""Generate a separate tvOS app without touching the iPad project or settings."""
import argparse, hashlib, json, plistlib, re, shutil, subprocess
from pathlib import Path
import generate_project as g
from quality_resources import sync_quality
ROOT = Path(__file__).resolve().parents[1]

def generate(fixture_media=None):
    g.objects.clear()
    web=ROOT/'Generated/TV/Web';web.mkdir(parents=True,exist_ok=True)
    text=(ROOT.parent/'native/find-webclient.js').read_text()
    remote=re.search(r"const DEFAULT_REMOTE_SERVER = '([^']+)'",text).group(1)
    local_ip=re.search(r"const DEFAULT_LOCAL_SERVER_IP = '([^']+)'",text).group(1)
    port=re.search(r'DEFAULT_LOCAL_SERVER_IP}:(\d+)/',text).group(1)
    (web/'server_defaults.json').write_text(json.dumps({'remote':remote,'local':f'http://{local_ip}:{port}/','localIP':local_ip},indent=2)+'\n')
    shutil.copyfile(ROOT/'Resources/cacert.pem',web/'cacert.pem')
    sync_quality(ROOT.parent, web, {'files': {}})
    # Television-only tier: preserve desktop profile bytes and color settings.
    catalog=web/'quality_presets.json';presets=json.loads(catalog.read_text())
    light={'id':'tv-balanced','title':'轻量增强','base':'high-quality',
           'options':{'scale':'bilinear','cscale':'bilinear','dscale':'bilinear',
                      'deband':'no','sigmoid-upscaling':'no'},
           'shaders':['shaders/RAISR/ravu_lite_ar_r3.glsl']}
    for shader in light['shaders']:
        target=web/shader;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT.parent/'resources/mpv'/shader,target)
    catalog.write_text(json.dumps([*presets,light],ensure_ascii=False,indent=2)+'\n')
    art=ROOT/'Generated/TV/home-art'
    shutil.copytree(ROOT.parent/'native/home-art', art, dirs_exist_ok=True)
    fonts=ROOT/'Generated/TV/SubtitleFonts';fonts.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(ROOT/'Resources/SubtitleFonts/SourceHanSansSC-Regular.otf', fonts/'SourceHanSansSC-Regular.otf')
    licenses=web/'licenses';licenses.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(ROOT/'Resources/SubtitleFonts/LICENSE.txt', licenses/'SourceHanSans-LICENSE.txt')
    manifest={'revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'files':{str(path.relative_to(web)):hashlib.sha256(path.read_bytes()).hexdigest()
                       for path in sorted(web.rglob('*')) if path.is_file() and path.name != 'manifest.json'}}
    (web/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    files=[];sources=[]
    shared=[ROOT/'App/Playback/MPVEngine.swift', ROOT/'App/ServerPresets.swift']
    shared += [ROOT/'App/Danmaku'/name for name in ['DanmakuHost.swift','DanmakuRepository.swift','DanmakuOverlay.swift']]
    for path in sorted((ROOT/'TV').glob('*.swift')) + shared:
        relative=str(path.relative_to(ROOT));ref=g.file(relative,'sourcecode.swift');files.append(ref)
        sources.append(g.obj(relative+'tvbuild','PBXBuildFile',fileRef=ref))
    ref=g.file('Generated/TV/Web','folder');files.append(ref)
    resources=[g.obj('tvwebres','PBXBuildFile',fileRef=ref)]
    ref=g.file('Generated/TV/home-art','folder');files.append(ref)
    resources.append(g.obj('tvartres','PBXBuildFile',fileRef=ref))
    ref=g.file('Generated/TV/SubtitleFonts','folder');files.append(ref)
    resources.append(g.obj('tvfontsres','PBXBuildFile',fileRef=ref))
    ref=g.file('Resources/TV.xcassets','folder.assetcatalog');files.append(ref)
    resources.append(g.obj('tviconsres','PBXBuildFile',fileRef=ref))
    ref=g.file('Config/TV/PrivacyInfo.xcprivacy','text.xml');files.append(ref)
    resources.append(g.obj('tvprivacyres','PBXBuildFile',fileRef=ref))
    if fixture_media:
        fixture=ROOT/'Generated/TV/tv-fixture.mp4';shutil.copyfile(fixture_media,fixture)
        ref=g.file('Generated/TV/tv-fixture.mp4','file');files.append(ref);resources.append(g.obj('tvfixtureres','PBXBuildFile',fileRef=ref))
    core=g.obj('tvcore','XCLocalSwiftPackageReference',relativePath='Core')
    corelib=g.obj('tvcorelib','XCSwiftPackageProductDependency',productName='AppleCore',package=core)
    mpv=g.obj('tvmpv','XCRemoteSwiftPackageReference',repositoryURL='https://github.com/mpvkit/MPVKit.git',requirement={'kind':'revision','revision':'d9194243bdc68b87d8989376ab52aee7da6c8e0b'})
    mpvlib=g.obj('tvmpvlib','XCSwiftPackageProductDependency',productName='MPVKit',package=mpv)
    product=g.obj('tvproduct','PBXFileReference',explicitFileType='wrapper.application',path='TigerestTV.app',sourceTree='BUILT_PRODUCTS_DIR')
    settings={'PRODUCT_NAME':'TigerestTV','PRODUCT_BUNDLE_IDENTIFIER':'top.tigerest.theater.tv','INFOPLIST_FILE':'Config/TVInfo.plist','SWIFT_VERSION':'5.0','TVOS_DEPLOYMENT_TARGET':'26.0','TARGETED_DEVICE_FAMILY':'3','TIGEREST_DISTRIBUTION':'github','CODE_SIGN_STYLE':'Automatic','SDKROOT':'appletvos','SUPPORTED_PLATFORMS':'appletvos appletvsimulator','CLANG_ENABLE_MODULES':'YES','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/Frameworks','ENABLE_USER_SCRIPT_SANDBOXING':'YES','GENERATE_INFOPLIST_FILE':'NO'}
    target=g.obj('tvapp','PBXNativeTarget',name='TigerestTV',productName='TigerestTV',productReference=product,productType='com.apple.product-type.application',buildConfigurationList=g.configurations('tvapp',{**settings,'ASSETCATALOG_COMPILER_APPICON_NAME':'App Icon & Top Shelf Image'}),buildPhases=[g.obj('tvsrc','PBXSourcesBuildPhase',buildActionMask=2147483647,files=sources,runOnlyForDeploymentPostprocessing=0),g.obj('tvres','PBXResourcesBuildPhase',buildActionMask=2147483647,files=resources,runOnlyForDeploymentPostprocessing=0),g.obj('tvframeworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[g.obj(x+'tvlink','PBXBuildFile',productRef=x) for x in [corelib,mpvlib]],runOnlyForDeploymentPostprocessing=0)],buildRules=[],dependencies=[],packageProductDependencies=[corelib,mpvlib])
    testfiles=[]
    for path in sorted((ROOT/'TVUITests').glob('*.swift')):
        relative=str(path.relative_to(ROOT));ref=g.file(relative,'sourcecode.swift');files.append(ref);testfiles.append(g.obj(relative+'tvtestbuild','PBXBuildFile',fileRef=ref))
    testproduct=g.obj('tvtestproduct','PBXFileReference',explicitFileType='wrapper.cfbundle',path='TigerestTVUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR')
    projectID=hashlib.sha256(b'tvproject').hexdigest()[:24].upper()
    proxy=g.obj('tvproxy','PBXContainerItemProxy',containerPortal=projectID,proxyType=1,remoteGlobalIDString=target,remoteInfo='TigerestTV')
    dependency=g.obj('tvtestdepend','PBXTargetDependency',target=target,targetProxy=proxy)
    testtarget=g.obj('tvtests','PBXNativeTarget',name='TigerestTVUITests',productName='TigerestTVUITests',productReference=testproduct,productType='com.apple.product-type.bundle.ui-testing',buildConfigurationList=g.configurations('tvtests',{**settings,'PRODUCT_NAME':'TigerestTVUITests','PRODUCT_BUNDLE_IDENTIFIER':'top.tigerest.theater.tv.uitests','GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_FILE':'','TEST_TARGET_NAME':'TigerestTV'}),buildPhases=[g.obj('tvtestsrc','PBXSourcesBuildPhase',buildActionMask=2147483647,files=testfiles,runOnlyForDeploymentPostprocessing=0)],dependencies=[dependency],buildRules=[])
    products=g.obj('tvproducts','PBXGroup',name='Products',children=[product,testproduct],sourceTree='<group>')
    main=g.obj('tvmain','PBXGroup',children=files+[products],sourceTree='<group>')
    g.obj('tvproject','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700'},buildConfigurationList=g.configurations('tvproject',{'CLANG_ENABLE_MODULES':'YES'}),compatibilityVersion='Xcode 14.0',developmentRegion='zh-Hans',knownRegions=['en','zh-Hans','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=[target,testtarget],packageReferences=[core,mpv])
    project=ROOT/'TigerestTV.xcodeproj';project.mkdir(exist_ok=True)
    (project/'project.pbxproj').write_bytes(plistlib.dumps({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':g.objects,'rootObject':projectID},sort_keys=False))
    schemes=project/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
    def ref(ident,name,product):return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident}" BuildableName="{product}" BlueprintName="{name}" ReferencedContainer="container:TigerestTV.xcodeproj"/>'
    app=ref(target,'TigerestTV','TigerestTV.app');test=ref(testtarget,'TigerestTVUITests','TigerestTVUITests.xctest')
    scheme=f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{app}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>'''
    (schemes/'TigerestTV.xcscheme').write_text(scheme)
    # Automatic XCTest video recording materially loads the TV GPU. Performance
    # runs must disable it, rather than merely deleting recordings after success.
    plan={'configurations':[{'id':'5411C676-3539-4470-A345-A9320D8BA2EF','name':'Playback','options':{}}],
          'defaultOptions':{'uiTestingScreenshotsLifetime':'keepNever','userAttachmentLifetime':'keepNever'},
          'testTargets':[{'target':{'containerPath':'container:TigerestTV.xcodeproj','identifier':testtarget,'name':'TigerestTVUITests'},
                          'selectedTests':['TVNavigationTests/testLightweightSustainedPlayback()']}], 'version':1}
    (ROOT/'TigerestTVPerformance.xctestplan').write_text(json.dumps(plan,indent=2)+'\n')
    performance=scheme.replace(f'<Testables><TestableReference skipped="NO">{test}</TestableReference></Testables>',
                              '<TestPlans><TestPlanReference reference="container:TigerestTVPerformance.xctestplan" default="YES"/></TestPlans>')
    performance=performance.replace('<TestAction buildConfiguration="Debug"', '<TestAction buildConfiguration="Release"')
    (schemes/'TigerestTVPerformance.xcscheme').write_text(performance)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--fixture-media',type=Path);args=parser.parse_args();generate(args.fixture_media)
