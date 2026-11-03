"""Exercise the full script/native filter through the real streaming mpv bridge."""
from fractions import Fraction
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_rife_mpv_eof import quote_option


@unittest.skipUnless(all(os.environ.get(k) for k in ('RIFE_MPV_BINARY','RIFE_VS_PLUGIN','RIFE_SMALL_MODEL')),
                     'requires explicit native mpv/plugin/model paths')
class RifeStreamingTests(unittest.TestCase):
    def exercise_stream(self,fps_num,fps_den,count):
        repository=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='rife 播放 test ') as tmp:
            root=Path(tmp)
            video,script,report=root/'clip.mkv',root/'bridge.vpy',root/'frames.jsonl'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'testsrc2=size=128x128:rate={fps_num}/{fps_den}',
                '-frames:v',str(count),'-c:v','ffv1','-vf','setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-color_range','tv','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
                str(video)],check=True,timeout=30)
            options={'plugin_path':str(Path(os.environ['RIFE_VS_PLUGIN']).resolve()),
                     'model_path':str(Path(os.environ['RIFE_SMALL_MODEL']).resolve()),
                     'fps_num':fps_num,'fps_den':fps_den,'streaming':True}
            script.write_text('''import vapoursynth as vs
import json,hashlib,runpy
settings=json.loads(user_data)
def record(kind):
    def inspect(n,f):
        row={'kind':kind,'n':n,'sha':hashlib.sha256(b''.join(bytes(f[c]) for c in range(f.format.num_planes))).hexdigest(),
             'num':f.props.get('_DurationNum',0),'den':f.props.get('_DurationDen',0),
             'synth':f.props.get('_TigerestRifeSynthesized',0),'reason':f.props.get('_TigerestRifeReason','')}
        with open(settings['report'],'a') as stream:stream.write(json.dumps(row)+'\\n')
        return f
    return inspect
source=vs.core.std.ModifyFrame(video_in,clips=video_in,selector=record('source'))
build=runpy.run_path(settings['script'])['build_rife_filter']
output=build(source,settings['options'])
vs.core.std.ModifyFrame(output,clips=output,selector=record('output')).set_output()
''')
            data=json.dumps({'options':options,'script':str(repository/'resources/mpv/rife/interpolate.vpy'),'report':str(report)})
            vf='vapoursynth=file='+quote_option(str(script))+':user-data='+quote_option(data)+':eof-aware=yes:buffered-frames=4:concurrent-frames=2'
            run=subprocess.run([os.environ['RIFE_MPV_BINARY'],'--no-config','--vo=null','--ao=null','--untimed',
                                '--vf='+vf,str(video)],capture_output=True,text=True,timeout=60)
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            self.assertTrue(report.exists(),run.stdout+run.stderr)
            rows=[json.loads(line) for line in report.read_text().splitlines()]
            originals={row['n']:row for row in rows if row['kind']=='source'}
            frames=sorted((row for row in rows if row['kind']=='output'),key=lambda row:row['n'])
            self.assertEqual([row['n'] for row in frames],list(range(count*2)),run.stdout+run.stderr)
            expected=[int(n%2==1 and n//2<count-1) for n in range(count*2)]
            self.assertEqual([row['synth'] for row in frames],expected,frames)
            for index in list(range(0,count*2,2))+[count*2-1]:
                self.assertEqual(frames[index]['sha'],originals[index//2]['sha'])
            if count>1:self.assertNotEqual(frames[1]['sha'],originals[0]['sha'])
            self.assertEqual(sum((Fraction(f['num'],f['den']) for f in frames),Fraction()),Fraction(count*fps_den,fps_num))

    def test_real_stream_generates_frames_keeps_originals_and_finishes_last_frame(self):
        # 59997/2500 is container-fps 23.9988; doubling it used to abort mpv.
        for fps_num,fps_den,count in [(24000,1001,1),(24000,1001,3),(30000,1001,131),(59997,2500,3)]:
            with self.subTest(rate=(fps_num,fps_den),frames=count):
                self.exercise_stream(fps_num,fps_den,count)


if __name__=='__main__':unittest.main()
