"""Reproduce one already-approved v2.3.3 extension from the original full ZIP."""
import argparse
import json
import sys
import zipfile
import zlib
from pathlib import Path

from package_extension import build_extension
from probe_runtime import file_hash
from verify_extension import verify_extension

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--architecture', required=True,
                    choices=('sm75', 'sm80', 'sm86', 'sm89', 'sm90', 'sm100', 'sm120'))
args = parser.parse_args()
assert sys.version_info[:3] == (3, 14, 5), sys.version
assert zlib.ZLIB_RUNTIME_VERSION == '1.3.1.zlib-ng', zlib.ZLIB_RUNTIME_VERSION
catalog = json.loads(Path('resources/rife/windows-catalog.json').read_text(encoding='utf-8'))
package_id = 'rife-nvidia-r79-' + args.architecture
expected = next(p for p in catalog['packages'] if p['id'] == package_id)
assert expected['sourceSha'] == '14ef3375008dda80ed2a5c712fa659530f51ceeb'
archive = Path('original/Tigerest-RIFE-NVIDIA-1.0.0.zip')
verify_extension(archive, catalog, 'rife-nvidia-r79', '2.3.3')
source = Path('verified-original')
source.mkdir(exist_ok=False)
# Full verification above has rejected unsafe paths, links and unlisted files.
with zipfile.ZipFile(archive) as package:
    package.extractall(source)
filename = 'Tigerest-RIFE-NVIDIA-' + args.architecture + '-1.0.0.zip'
output = Path('reproduced') / filename
item = build_extension(source / 'runtime', source / 'playback', source / 'notices', output,
    package_id=package_id, version=expected['version'], source_sha=expected['sourceSha'],
    min_app_version=expected['minAppVersion'], max_app_version=expected['maxAppVersion'],
    gpu_architecture=args.architecture)
for key in ('sha256', 'manifestSha256', 'downloadSize', 'unpackedSize', 'fileCount'):
    assert item[key] == expected[key], (key, item[key], expected[key])
verify_extension(output, catalog, package_id, '2.3.3')
assert file_hash(output) == expected['sha256']
proof = {'architecture': args.architecture, 'python': sys.version,
         'zlib': zlib.ZLIB_RUNTIME_VERSION, 'matchesApprovedCatalog': True,
         'name': filename, 'sha256': expected['sha256'], 'size': expected['downloadSize']}
Path('reproduction-proof.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
print(json.dumps(proof), flush=True)
