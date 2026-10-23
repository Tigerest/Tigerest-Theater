#!/usr/bin/env python3
import argparse, os, subprocess
from pathlib import Path
from generate_project import generate, ROOT
parser=argparse.ArgumentParser();parser.add_argument('--team');parser.add_argument('--signed',action='store_true');parser.add_argument('--device');parser.add_argument('--simulator',action='store_true');parser.add_argument('--testflight',action='store_true',help='build the TestFlight variant');args=parser.parse_args()
version=subprocess.check_output(['xcodebuild','-version'],text=True)
if not version.startswith('Xcode 27.'):raise SystemExit('请将 DEVELOPER_DIR 指向 Xcode 27 beta')
generate()
command=['xcodebuild','-project',str(ROOT/'TigerestTheater.xcodeproj'),'-scheme','TigerestTheater','-configuration','Debug','-derivedDataPath',str(ROOT/'DerivedData'),'-sdk','iphonesimulator' if args.simulator else 'iphoneos']
if args.team or args.signed:
    command+=['-allowProvisioningUpdates','-allowProvisioningDeviceRegistration']
    if args.team:command+=['DEVELOPMENT_TEAM='+args.team]
else:command+=['CODE_SIGNING_ALLOWED=NO']
if args.testflight:command+=['TIGEREST_DISTRIBUTION=testflight']
if args.device:command+=['-destination','id='+args.device]
raise SystemExit(subprocess.call(command+['build']))
