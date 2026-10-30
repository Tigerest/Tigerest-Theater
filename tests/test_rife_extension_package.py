import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'dev/windows/rife'))
from package_extension import build_extension
from verify_extension import verify_extension, catalog_item


class ExtensionPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='RIFE 扩展 ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root/'runtime'
        self.runtime.mkdir()
        data = b'isolated-runtime-test-fixture'
        (self.runtime/'fixture.dll').write_bytes(data)
        (self.runtime/'runtime.json').write_text(json.dumps({
            'schemaVersion': 1, 'backend': 'windows-nvidia-trt', 'runtimeId': 'fixture-r79',
            'files': [{'path': 'fixture.dll', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]
        }), encoding='utf-8')
        self.playback = self.root/'playback'
        self.playback.mkdir()
        for name in ('interpolate_trt.vpy','trt_pipeline.py','tigerest-rife-vs.dll'):
            (self.playback/name).write_bytes(b'fixture-'+name.encode())
        self.notices = self.root/'notices'
        self.notices.mkdir()
        (self.notices/'NOTICE.txt').write_text('Local test fixture; not redistributable runtime')
        self.archive = self.root/'extension.zip'
        self.item = build_extension(self.runtime, self.playback, self.notices, self.archive,
            package_id='rife-test-win64', version='0.1.0', source_sha='a'*40,
            min_app_version='2.1.2', max_app_version='3.0.0')
        self.catalog = {'schemaVersion': 1, 'packages': [self.item]}

    def verify(self, path=None):
        return verify_extension(path or self.archive, self.catalog, 'rife-test-win64', '2.1.2')

    def malicious(self, mutate):
        target = self.root/'malicious.zip'
        with zipfile.ZipFile(self.archive) as source, zipfile.ZipFile(target,'w') as result:
            for entry in source.infolist():
                result.writestr(entry,source.read(entry))
            mutate(result)
        # Deliberately trust the malicious archive hash to exercise validation
        # beyond the outer hash; production catalog never accepts arbitrary hashes.
        self.item['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
        self.item['downloadSize'] = target.stat().st_size
        with zipfile.ZipFile(target) as changed:
            self.item['fileCount'] = len(changed.infolist())
            self.item['unpackedSize'] = sum(info.file_size for info in changed.infolist())
        return target

    def test_zip64_round_trip_and_no_generated_engines(self):
        report = self.verify()
        self.assertEqual(report['runtimeId'], 'fixture-r79')
        self.assertEqual(report['unpackedSize'], self.item['unpackedSize'])
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.read('playback/trt_pipeline.py'), b'fixture-trt_pipeline.py')
            self.assertFalse(any(name.endswith('.engine') for name in archive.namelist()))
            # Builder forces ZIP64 local headers, even for the tiny fixture.
            self.assertTrue(any(info.extract_version >= 45 for info in archive.infolist()))

    def test_catalog_can_explicitly_approve_a_new_app_without_resealing_archive(self):
        self.item['compatibleAppVersions'] = ['3.0.0']
        report = verify_extension(self.archive, self.catalog, 'rife-test-win64', '3.0.0')
        self.assertEqual(report['runtimeId'], 'fixture-r79')
        with self.assertRaisesRegex(ValueError, 'application version'):
            catalog_item(self.catalog, 'rife-test-win64', '3.0.1')

    def test_shipped_catalog_supports_the_actual_release_version(self):
        catalog = json.loads((ROOT/'resources/rife/windows-catalog.json').read_text())
        # The client checks extensions with its canonical major.minor.patch
        # version (VERSION_BASE), so a fix release such as 2.9.5.1 asks as 2.9.5.
        app = re.match(r'\d+\.\d+\.\d+', (ROOT/'VERSION').read_text().strip()).group(0)
        item = catalog_item(catalog, 'rife-nvidia-r79', app)
        self.assertTrue(item['url'].startswith('https://github.com/Tigerest/'))

    def test_explicit_compatibility_keeps_hash_and_abi_checks(self):
        self.item['compatibleAppVersions'] = ['3.0.0']
        self.item['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'hash'):
            verify_extension(self.archive, self.catalog, 'rife-test-win64', '3.0.0')
        self.item['abi'] = 'unverified-abi'
        with self.assertRaisesRegex(ValueError, 'ABI'):
            catalog_item(self.catalog, 'rife-test-win64', '3.0.0')

    def test_catalog_hash_identity_and_app_range_are_authoritative(self):
        with self.assertRaisesRegex(ValueError,'catalog'):
            verify_extension(self.archive,self.catalog,'unknown','2.1.2')
        self.item['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError,'hash'):
            self.verify()
        self.item['sha256'] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'version'):
            verify_extension(self.archive,self.catalog,'rife-test-win64','3.0.0')
        self.item['architecture'] = 'arm64'
        with self.assertRaisesRegex(ValueError,'architecture|ABI'):
            self.verify()

    def test_unsafe_names_links_and_duplicate_windows_paths_are_rejected(self):
        for name in ('../outside','/absolute','C:/outside','runtime/CON.txt','runtime/a.','runtime/a:b'):
            with self.subTest(name=name):
                target=self.malicious(lambda archive: archive.writestr(name,b'bad'))
                with self.assertRaisesRegex(ValueError,'^(Invalid|Unsafe) archive file path'):
                    self.verify(target)
        info=zipfile.ZipInfo('runtime/link');info.create_system=3
        info.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaisesRegex(ValueError,'^Archive link/non-file entry'):
            self.verify(self.malicious(lambda archive: archive.writestr(info,b'../outside')))
        info=zipfile.ZipInfo('runtime/directory');info.create_system=0;info.external_attr=0x10
        with self.assertRaisesRegex(ValueError,'^Archive link/non-file entry'):
            self.verify(self.malicious(lambda archive: archive.writestr(info,b'folder')))
        with self.assertRaisesRegex(ValueError,'^Duplicate Windows archive path'):
            self.verify(self.malicious(lambda archive: archive.writestr('RUNTIME/FIXTURE.DLL',b'bad')))

    def test_unpack_limits_and_file_directory_collisions_are_rejected(self):
        self.item['unpackedSize']-=1
        with self.assertRaisesRegex(ValueError,'size'):
            self.verify()
        with self.assertRaisesRegex(ValueError,'^Archive file/directory path collision'):
            self.verify(self.malicious(lambda archive: archive.writestr('runtime',b'parent file')))

    def test_raw_zip_names_cannot_hide_nul_or_windows_backslashes(self):
        # Write local + central headers ourselves: ZipInfo.writestr would
        # normalize the names before the hostile archive reached the reader.
        for raw_name in (b'runtime\\fixture.dll', b'runtime/fixture.dll\x00hidden'):
            with self.subTest(raw_name=raw_name):
                chunks=[];central=[];offset=0
                with zipfile.ZipFile(self.archive) as source:
                    for info in source.infolist():
                        name=raw_name if info.filename=='runtime/fixture.dll' else info.filename.encode('utf-8')
                        data=source.read(info);crc=zlib.crc32(data);size=len(data)
                        local=struct.pack('<IHHHHHIIIHH',0x04034b50,20,0x800,0,0,0,crc,size,size,len(name),0)+name+data
                        central.append(struct.pack('<IHHHHHHIIIHHHHHII',0x02014b50,0x314,20,0x800,0,0,0,
                            crc,size,size,len(name),0,0,0,0,info.external_attr,offset)+name)
                        chunks.append(local);offset+=len(local)
                directory=b''.join(central)
                raw=b''.join(chunks)+directory+struct.pack('<IHHHHIIH',0x06054b50,0,0,len(central),len(central),len(directory),offset,0)
                target=self.root/'raw-names.zip';target.write_bytes(raw)
                self.item['sha256']=hashlib.sha256(raw).hexdigest();self.item['downloadSize']=len(raw)
                with self.assertRaisesRegex(ValueError,'^(Invalid|Unsafe) archive file path'):
                    self.verify(target)

    def test_extra_file_or_changed_payload_rejected_despite_matching_zip_hash(self):
        with self.assertRaisesRegex(ValueError,'entry|file'):
            self.verify(self.malicious(lambda archive: archive.writestr('unknown.py',b'bad')))
        target=self.root/'changed.zip'
        with zipfile.ZipFile(self.archive) as source,zipfile.ZipFile(target,'w') as result:
            for info in source.infolist():
                result.writestr(info, b'x'*info.file_size if info.filename=='runtime/fixture.dll' else source.read(info))
        self.item['sha256']=hashlib.sha256(target.read_bytes()).hexdigest()
        self.item['downloadSize']=target.stat().st_size
        with zipfile.ZipFile(target) as changed:
            self.item['fileCount']=len(changed.infolist())
            self.item['unpackedSize']=sum(info.file_size for info in changed.infolist())
        with self.assertRaisesRegex(ValueError,'hash'):
            self.verify(target)

    def test_corrupt_source_cannot_replace_existing_output(self):
        before=self.archive.read_bytes()
        (self.runtime/'fixture.dll').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            build_extension(self.runtime,self.playback,self.notices,self.archive,
                package_id='rife-test-win64',version='0.1.0',source_sha='a'*40,
                min_app_version='2.1.2',max_app_version='3.0.0')
        self.assertEqual(self.archive.read_bytes(),before)

    def build(self,output=None):
        return build_extension(self.runtime,self.playback,self.notices,output or self.root/'new.zip',
            package_id='rife-test-win64',version='0.1.0',source_sha='a'*40,
            min_app_version='2.1.2',max_app_version='3.0.0')

    def test_engine_extensions_are_case_insensitive_and_real_notices_required(self):
        engine=self.runtime/'cache.ENGINE';engine.write_bytes(b'generated')
        manifest_path=self.runtime/'runtime.json'
        manifest=json.loads(manifest_path.read_text())
        manifest['files'].append({'path':engine.name,'size':9,'sha256':hashlib.sha256(engine.read_bytes()).hexdigest()})
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'engine'):
            self.build()
        engine.unlink();manifest['files'].pop();manifest_path.write_text(json.dumps(manifest))
        (self.notices/'NOTICE.txt').unlink();(self.notices/'empty').mkdir()
        with self.assertRaisesRegex(ValueError,'notice'):
            self.build(self.root/'no-notices.zip')

    def test_valid_source_and_racing_publish_never_replace_output(self):
        before=self.archive.read_bytes()
        with self.assertRaisesRegex(ValueError,'already exists'):
            self.build(self.archive)
        self.assertEqual(self.archive.read_bytes(),before)
        output=self.root/'racing.zip';actual_link=os.link
        def race(source,destination):
            output.write_bytes(b'other publisher owns this')
            return actual_link(source,destination)
        with patch('package_extension.os.link',side_effect=race):
            with self.assertRaises(FileExistsError):
                self.build(output)
        self.assertEqual(output.read_bytes(),b'other publisher owns this')
        self.assertFalse(list(self.root.glob('*.zip.tmp')))

    def architecture_runtime(self):
        manifest=json.loads((self.runtime/'runtime.json').read_text())
        manifest['versions']={'tensorrt':'10.16.0'}
        for architecture in ('ptx','sm75','sm80','sm86','sm89','sm90','sm100','sm120'):
            name='plugins/vsmlrt-cuda/nvinfer_builder_resource_'+architecture+'_10.dll'
            path=self.runtime/name;path.parent.mkdir(parents=True,exist_ok=True)
            data=('resource-'+architecture).encode();path.write_bytes(data)
            manifest['files'].append({'path':name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        (self.runtime/'runtime.json').write_text(json.dumps(manifest))
        return manifest

    def build_architecture(self,architecture):
        return build_extension(self.runtime,self.playback,self.notices,self.root/(architecture+'.zip'),
            package_id='rife-test-'+architecture,version='0.1.0',source_sha='a'*40,
            min_app_version='2.1.2',max_app_version='3.0.0',gpu_architecture=architecture)

    def test_each_architecture_package_retains_ptx_shared_files_and_models(self):
        original=self.architecture_runtime()
        for architecture in ('sm75','sm80','sm86','sm89','sm90','sm100','sm120'):
            with self.subTest(architecture=architecture):
                item=self.build_architecture(architecture)
                verify_extension(self.root/(architecture+'.zip'),{'schemaVersion':1,'packages':[item]},item['id'],'2.1.2')
                with zipfile.ZipFile(self.root/(architecture+'.zip')) as archive:
                    runtime=json.loads(archive.read('runtime/runtime.json'))
                    self.assertEqual(runtime['gpuArchitecture'],architecture)
                    self.assertEqual(item['gpuArchitecture'],architecture)
                    self.assertEqual(runtime['runtimeId'],'fixture-r79-'+architecture)
                    self.assertEqual({x['path'] for x in runtime['files']},{'fixture.dll',
                        'plugins/vsmlrt-cuda/nvinfer_builder_resource_ptx_10.dll',
                        'plugins/vsmlrt-cuda/nvinfer_builder_resource_'+architecture+'_10.dll'})
                    self.assertEqual(archive.read('runtime/fixture.dll'),b'isolated-runtime-test-fixture')
        self.assertEqual(json.loads((self.runtime/'runtime.json').read_text()),original)
        full=self.build_architecture('full')
        with zipfile.ZipFile(self.root/'full.zip') as archive:
            self.assertEqual(len(json.loads(archive.read('runtime/runtime.json'))['files']),9)
            self.assertEqual(full['runtimeId'],'fixture-r79')

    def test_architecture_package_rejects_missing_ptx_or_requested_resource(self):
        manifest=self.architecture_runtime()
        for missing in ('ptx','sm89'):
            reduced=dict(manifest,files=[x for x in manifest['files'] if '_'+missing+'_' not in x['path']])
            removed=self.runtime/next(x['path'] for x in manifest['files'] if '_'+missing+'_' in x['path'])
            data=removed.read_bytes();removed.unlink()
            (self.runtime/'runtime.json').write_text(json.dumps(reduced))
            with self.assertRaisesRegex(ValueError,'builder resource'):
                self.build_architecture('sm89')
            removed.write_bytes(data)
        (self.runtime/'runtime.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'architecture'):
            self.build_architecture('sm999')

    def test_architecture_identity_cannot_be_relabeled_by_catalog(self):
        self.architecture_runtime()
        item=self.build_architecture('sm89');item['gpuArchitecture']='sm86'
        with self.assertRaisesRegex(ValueError,'identity'):
            verify_extension(self.root/'sm89.zip',{'schemaVersion':1,'packages':[item]},item['id'],'2.1.2')


if __name__ == '__main__':
    unittest.main()
