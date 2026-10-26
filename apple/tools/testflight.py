#!/usr/bin/env python3
"""Archive the TestFlight variant and export it for, or upload it to, App Store Connect.

Needs a paid Apple Developer Program team. Without --upload the signed IPA is only
exported locally; with --upload xcodebuild sends it to App Store Connect using the
account signed in to Xcode, or an App Store Connect API key when one is given.
"""
import argparse, datetime, plistlib, re, subprocess
from pathlib import Path
import generate_project, generate_tv_project
ROOT = generate_project.ROOT
PLATFORMS = {
    'ios': ('TigerestTheater.xcodeproj', 'TigerestTheater', 'Config/Info.plist', 'generic/platform=iOS', generate_project.generate),
    'tvos': ('TigerestTV.xcodeproj', 'TigerestTV', 'Config/TVInfo.plist', 'generic/platform=tvOS', generate_tv_project.generate),
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--platform', choices=PLATFORMS, default='ios')
parser.add_argument('--team', help='Developer Program team ID (default: DEVELOPMENT_TEAM in apple/Local.xcconfig)')
parser.add_argument('--bundle-id', help='override the bundle identifier registered in App Store Connect')
parser.add_argument('--upload', action='store_true', help='upload to App Store Connect instead of exporting an IPA')
parser.add_argument('--api-key-path', help='App Store Connect API key (.p8); default is the Xcode account')
parser.add_argument('--api-key-id')
parser.add_argument('--api-issuer')
args = parser.parse_args()
if bool(args.api_key_path) != bool(args.api_key_id) or bool(args.api_key_id) != bool(args.api_issuer):
    parser.error('--api-key-path, --api-key-id and --api-issuer go together')
if not subprocess.check_output(['xcodebuild', '-version'], text=True).startswith('Xcode 27.'):
    raise SystemExit('请将 DEVELOPER_DIR 指向 Xcode 27 beta')
team = args.team or (re.search(r'^DEVELOPMENT_TEAM\s*=\s*(\w+)', (ROOT/'Local.xcconfig').read_text(), re.M) or [None, None])[1]
if not team:
    raise SystemExit('缺少开发者团队 ID：传入 --team，或写入 apple/Local.xcconfig')

def run(command, failure):
    if subprocess.call(command) != 0:
        raise SystemExit(failure)

project, scheme, plist, destination, generate = PLATFORMS[args.platform]
generate()
version = plistlib.loads((ROOT/plist).read_bytes())['CFBundleShortVersionString']
# Every upload needs a build number above the previous one for the same version.
now = datetime.datetime.now(datetime.timezone.utc)
build = f"{version.replace('.', '')}.{now:%Y%m%d}.{now:%H%M}"
output = ROOT/'DerivedDataTestFlight'/'Archives'/f'{args.platform}-{build}'
output.mkdir(parents=True, exist_ok=True)
archive = output/f'{scheme}.xcarchive'
settings = ['TIGEREST_DISTRIBUTION=testflight', f'CURRENT_PROJECT_VERSION={build}', f'DEVELOPMENT_TEAM={team}', 'CODE_SIGN_STYLE=Automatic']
if args.bundle_id:
    settings.append(f'PRODUCT_BUNDLE_IDENTIFIER={args.bundle_id}')
run(['xcodebuild', '-project', str(ROOT/project), '-scheme', scheme, '-configuration', 'Release',
     '-destination', destination, '-derivedDataPath', str(ROOT/'DerivedDataTestFlight'),
     '-archivePath', str(archive), '-allowProvisioningUpdates', *settings, 'archive'],
    'Archive 失败，见上方 xcodebuild 输出。')

options = output/'ExportOptions.plist'
options.write_bytes(plistlib.dumps({'method': 'app-store-connect', 'teamID': team, 'signingStyle': 'automatic',
                                    'destination': 'upload' if args.upload else 'export',
                                    'uploadSymbols': True, 'manageAppVersionAndBuildNumber': False}))
authentication = ['-authenticationKeyPath', args.api_key_path, '-authenticationKeyID', args.api_key_id,
                  '-authenticationKeyIssuerID', args.api_issuer] if args.api_key_path else []
run(['xcodebuild', '-exportArchive', '-archivePath', str(archive), '-exportPath', str(output/'export'),
     '-exportOptionsPlist', str(options), '-allowProvisioningUpdates', *authentication],
    f'Archive 已生成（{archive}），但导出失败。免费的个人团队没有分发证书，需要已开通 Apple Developer Program 的团队 ID；其他原因见上方 xcodebuild 输出。')
print(f'{version} ({build}) ' + ('已上传到 App Store Connect，处理完成后会出现在 TestFlight。' if args.upload else f'已导出：{output/"export"}'))
