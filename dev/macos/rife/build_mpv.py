#!/usr/bin/env python3
"""Build the pinned libmpv with EOF-aware VS and safe CoreAudio hotplug."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
from vapoursynth_runtime import inspect_runtime

VERSION='0.41.0'
SHA256='ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209'
HERE=Path(__file__).resolve().parent

def setup_meson(meson,out,source,arguments,env):
    # Meson ignores changed PKG_CONFIG_PATH on reconfigure and caches found
    # dependencies. Apply the ordered search paths as an option and rediscover
    # dependencies, including when reusing a build created with Homebrew R80.
    pkg_paths=[Path(p).as_posix() for p in env.get('PKG_CONFIG_PATH','').split(os.pathsep) if p]
    subprocess.run([meson,'setup',*(['--reconfigure','--clearcache'] if (out/'build.ninja').exists() else []),
                    str(out),str(source),*arguments,'-Dpkg_config_path='+json.dumps(pkg_paths)],env=env,check=True)

def build(destination,meson,runtime_python=None,deployment_target='26.0'):
    destination=destination.resolve();destination.mkdir(parents=True,exist_ok=True)
    archive=destination/f'mpv-v{VERSION}.tar.gz'
    if not archive.exists():
        subprocess.run(['curl','--fail','--location','--retry','3','--output',str(archive),
                        f'https://codeload.github.com/mpv-player/mpv/tar.gz/refs/tags/v{VERSION}'],check=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=SHA256:raise RuntimeError('mpv source hash mismatch')
    source=destination/f'mpv-{VERSION}'
    marker=source/'.tigerest-patches.json'
    patches=[HERE/'mpv-vapoursynth79.patch',HERE/'mpv-eof-aware.patch',
             HERE/'mpv-coreaudio-hotplug.patch']
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in patches}
    if not source.exists():
        with tarfile.open(archive) as tar:tar.extractall(destination,filter='data')
        for patch in patches:
            subprocess.run(['patch','-p1','-i',str(patch)],cwd=source,check=True)
        marker.write_text(json.dumps(hashes,indent=2)+'\n')
    elif not marker.exists() or json.loads(marker.read_text())!=hashes:
        raise RuntimeError('Existing mpv source lacks this patch provenance; choose a fresh build directory')
    out=destination/'mpv-build'
    architecture='arm64' if platform.machine()=='arm64' else 'x86_64'
    sdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
    minimum=f'-mmacosx-version-min={deployment_target}'
    arguments=['-Dbuildtype=release','-Dlibmpv=true','-Djavascript=enabled','-Dlua=luajit',
        '-Dlibarchive=enabled','-Duchardet=enabled','-Dvulkan=enabled','-Dvapoursynth=enabled',
        '-Dmanpage-build=disabled',f'-Dswift-flags=-target {architecture}-apple-macos{deployment_target}',
        f'-Dc_args={minimum}',f'-Dc_link_args={minimum}',f'-Dobjc_args={minimum}',f'-Dobjc_link_args={minimum}']
    env=dict(os.environ,MACOSX_DEPLOYMENT_TARGET=deployment_target,SDKROOT=sdk)
    brew=Path(subprocess.check_output(['brew','--prefix'],text=True).strip())
    pkg_paths=[str(brew/'opt'/name/'lib/pkgconfig') for name in ('libarchive','luajit','vapoursynth','libplacebo')]
    runtime = inspect_runtime(runtime_python) if runtime_python else None
    if runtime:
        pkg_paths.insert(0,runtime['pkgconfig'])
    env['PKG_CONFIG_PATH']=os.pathsep.join(pkg_paths+[env.get('PKG_CONFIG_PATH','')])
    setup_meson(meson,out,source,arguments,env)
    subprocess.run([meson,'compile','-C',str(out),'-j',str(min(os.cpu_count() or 4,8))],env=env,check=True)
    (destination/'mpv-provenance.json').write_text(json.dumps({
        'version':VERSION,'archive_sha256':SHA256,'patches':hashes,'deployment_target':deployment_target,
        'architecture':architecture,'vapoursynthVersion':runtime['vapoursynthVersion'] if runtime else None,
        'vapoursynthPkgConfig':runtime['pkgconfig'] if runtime else None},indent=2)+'\n')
    return out/'libmpv.dylib'

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--meson',default=shutil.which('meson'))
    parser.add_argument('--vapoursynth-python',type=Path)
    parser.add_argument('--deployment-target',default='26.0',
                        help='Minimum macOS; must not be newer than the bundle LSMinimumSystemVersion')
    args=parser.parse_args()
    if not args.meson:parser.error('Install Meson 1.9.2 in the build environment')
    print(build(args.output,args.meson,args.vapoursynth_python,args.deployment_target))
