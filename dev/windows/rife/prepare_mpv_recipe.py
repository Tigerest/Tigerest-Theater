"""Apply fixed sources and private Windows RIFE patches to an isolated recipe."""
import argparse
import json
from pathlib import Path
import re
import shutil
import tempfile

from probe_runtime import private_path

HERE = Path(__file__).resolve().parent


def prepare(recipe, lock):
    for relative, entry in lock['sources'].items():
        sha = entry['sourceSha']
        if not re.fullmatch('[0-9a-f]{40}', sha):
            raise ValueError('Invalid pinned source revision: ' + relative)
        path = private_path(recipe, relative)
        text = path.read_text(encoding='utf-8')
        if re.search(r'GIT_TAG\s+\S+', text):
            text = re.sub(r'GIT_TAG\s+\S+', 'GIT_TAG ' + sha, text, count=1)
        else:
            text = re.sub(r'(GIT_REPOSITORY\s+\S+)', r'\1\n    GIT_TAG ' + sha, text, count=1)
        if relative == 'packages/mpv.cmake':
            text = text.replace('    UPDATE_COMMAND ""',
                                '    PATCH_COMMAND git apply ${CMAKE_SOURCE_DIR}/tigerest-mpv-eof-aware.patch '
                                '${CMAKE_SOURCE_DIR}/tigerest-mpv-private-vs-core.patch\n    UPDATE_COMMAND ""', 1)
            text = text.replace('${CMAKE_SOURCE_DIR}/tigerest-mpv-private-vs-core.patch',
                                '${CMAKE_SOURCE_DIR}/tigerest-mpv-private-vs-core.patch '
                                '${CMAKE_SOURCE_DIR}/tigerest-mpv-win64-hwdec-pointer.patch '
                                '${CMAKE_SOURCE_DIR}/tigerest-mpv-win64-queue-pointer.patch '
                                '${CMAKE_SOURCE_DIR}/tigerest-mpv-win32-precise-flip.patch', 1)
        if relative == 'packages/ngtcp2.cmake':
            text = text.replace('    UPDATE_COMMAND ""',
                                '    PATCH_COMMAND git apply ${CMAKE_SOURCE_DIR}/tigerest-ngtcp2-static-openssl.patch\n'
                                '    UPDATE_COMMAND ""', 1)
            # Libraries in CFLAGS precede objects and cannot satisfy static
            # libcrypto's dependencies. The source patch attaches them to
            # OPENSSL_LIBRARIES, including CMake's QUIC capability probes.
            text = text.replace('        "-DCMAKE_C_FLAGS=\'-lz -lbrotlienc -lbrotlidec -lbrotlicommon -lzstd -lcrypt32\'"\n', '')
        if relative == 'packages/luajit.cmake':
            text = text.replace('PATCH_COMMAND ${EXEC} git am --3way ${CMAKE_CURRENT_SOURCE_DIR}/luajit-*.patch',
                                'PATCH_COMMAND git apply ${CMAKE_SOURCE_DIR}/tigerest-luajit-utf8.patch', 1)
        if relative == 'packages/curl.cmake':
            text = text.replace('    PATCH_COMMAND ""',
                                '    PATCH_COMMAND git apply ${CMAKE_SOURCE_DIR}/tigerest-curl-static-openssl.patch', 1)
            text = text.replace(' -lz -lbrotlienc -lbrotlidec -lbrotlicommon -lzstd -lcrypt32 -lsecur32', '')
        path.write_text(text, encoding='utf-8')
    shutil.copyfile(HERE.parents[1] / 'macos/rife/mpv-eof-aware.patch', recipe / 'tigerest-mpv-eof-aware.patch')
    shutil.copyfile(HERE / 'mpv-private-vs-core.patch', recipe / 'tigerest-mpv-private-vs-core.patch')
    shutil.copyfile(HERE / 'mpv-win64-hwdec-pointer.patch', recipe / 'tigerest-mpv-win64-hwdec-pointer.patch')
    shutil.copyfile(HERE / 'mpv-win64-queue-pointer.patch', recipe / 'tigerest-mpv-win64-queue-pointer.patch')
    shutil.copyfile(HERE / 'mpv-win32-precise-flip.patch', recipe / 'tigerest-mpv-win32-precise-flip.patch')
    shutil.copyfile(HERE / 'ngtcp2-static-openssl.patch', recipe / 'tigerest-ngtcp2-static-openssl.patch')
    shutil.copyfile(HERE / 'curl-static-openssl.patch', recipe / 'tigerest-curl-static-openssl.patch')
    # The recipe's UTF-8 patch uses a context line from a newer LuaJIT tree.
    # Frozen OpenResty 1edc3e5 has no lj_str_hash.o on that unchanged line,
    # and the next block starts with LJVMCORE_O. Adapt only those two context
    # lines; keep every UTF-8 implementation hunk intact.
    upstream_patch = recipe / 'packages/luajit-0001-add-win32-utf-8-filesystem-functions.patch'
    utf8_patch = upstream_patch.read_text(encoding='utf-8')
    old_context = ' \t  $(LJLIB_O) lib_init.o lj_str_hash.o\n \n ifeq (x64,$(TARGET_LJARCH))\n'
    if utf8_patch.count(old_context) != 1:
        raise ValueError('Unexpected upstream LuaJIT UTF-8 patch context')
    (recipe / 'tigerest-luajit-utf8.patch').write_text(
        utf8_patch.replace(old_context, ' \t  $(LJLIB_O) lib_init.o\n \n LJVMCORE_O= $(LJVM_O) $(LJCORE_O)\n', 1), encoding='utf-8', newline='\n')
    path = recipe / 'toolchain/rustup.cmake'
    text = path.read_text(encoding='utf-8')
    text = text.replace('--default-toolchain nightly', '--default-toolchain ' + lock['rustToolchain'])
    text = text.replace('BUILD_COMMAND ${EXEC} rustup update',
                        'BUILD_COMMAND ${EXEC} rustup default ' + lock['rustToolchain'])
    path.write_text(text, encoding='utf-8')
    # GNU's primary server has timed out repeatedly on CI. Both mirrors use
    # the recipe's original SHA512; no compiler source version is changed.
    for relative in ('toolchain/gcc/gcc.cmake', 'toolchain/gcc/gcc-binutils.cmake'):
        path = recipe / relative
        text = path.read_text(encoding='utf-8')
        text = re.sub(r'URL (https://ftp\.gnu\.org/gnu/\S+)',
                      lambda m: 'URL ' + m[1].replace('https://ftp.gnu.org/gnu/', 'https://mirrors.kernel.org/gnu/') + ' ' + m[1], text)
        path.write_text(text, encoding='utf-8')
    # Moving-branch recipes compare HEAD against @{u} after each install.
    # Immutable checkouts have no upstream: use HEAD and the pinned GIT_TAG.
    path = recipe / 'cmake/custom_steps.cmake'
    text = path.read_text(encoding='utf-8')
    text = text.replace('rev-parse @{u}', 'rev-parse HEAD')
    text = text.replace('set(reset "@{u}")', 'set(reset "${git_tag}")')
    # With a commit GIT_TAG, CMake may omit GIT_REMOTE_NAME. The recipe then
    # resets to the patched HEAD, making git-am fail on the next build.
    # Restore the actual locked source even when no remote name is recorded.
    text = text.replace('        set(reset "")', '        set(reset "${git_tag}")', 1)
    path.write_text(text, encoding='utf-8')


def verify_media_baseline(recipe, lock, baseline):
    # baseline is the developer tool from an explicitly pinned Git commit,
    # never an extension input. Compare the complete prepared dependency tree
    # before reusing a completed build; only mpv may differ and is rebuilt.
    namespace = {'__file__': str(Path(__file__).resolve()), '__name__': 'rife_media_baseline'}
    exec(compile(baseline.read_text(encoding='utf-8'), str(baseline), 'exec'), namespace)
    with tempfile.TemporaryDirectory(prefix='rife-media-compare-') as temp:
        root = Path(temp)
        previous, current = root / 'previous', root / 'current'
        for destination in (previous, current):
            shutil.copytree(recipe, destination, ignore=shutil.ignore_patterns('.git'))
        namespace['prepare'](previous, lock)
        prepare(current, lock)
        # This cleanup-only migration changes no dependency source or build
        # flags. Normalize the pinned legacy helper identically, then compare
        # every byte; arbitrary dependency changes still invalidate reuse.
        cleanup = previous / 'cmake/custom_steps.cmake'
        text = cleanup.read_text(encoding='utf-8')
        text = text.replace('        set(reset "")', '        set(reset "${git_tag}")', 1)
        cleanup.write_text(text, encoding='utf-8')
        allowed = {'packages/mpv.cmake', 'tigerest-mpv-win64-hwdec-pointer.patch',
                   'tigerest-mpv-win64-queue-pointer.patch', 'tigerest-mpv-win32-precise-flip.patch'}
        names = {path.relative_to(tree) for tree in (previous, current) for path in tree.rglob('*') if path.is_file()}
        for name in names:
            if name.as_posix() in allowed:
                continue
            if not (previous / name).is_file() or not (current / name).is_file() or (previous / name).read_bytes() != (current / name).read_bytes():
                raise ValueError('Media dependency differs from cache baseline: ' + str(name))
    print('Prepared media dependencies exactly match the pinned cache baseline; rebuild mpv only')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', required=True, type=Path)
    parser.add_argument('--lock', required=True, type=Path)
    parser.add_argument('--verify-media-baseline', type=Path)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text(encoding='utf-8'))
    if args.verify_media_baseline:
        verify_media_baseline(args.recipe.resolve(), lock, args.verify_media_baseline.resolve())
    else:
        prepare(args.recipe.resolve(), lock)


if __name__ == '__main__':
    main()
