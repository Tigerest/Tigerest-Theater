"""Actual plugin output/content/timing checks using the verified 128x128 model."""
from array import array
import ctypes
from fractions import Fraction
import math
import os
from pathlib import Path
import unittest
try:
    import vapoursynth as vs
except ImportError:
    if os.environ.get('RIFE_VS_PLUGIN'):raise
    raise unittest.SkipTest('requires the VapourSynth test interpreter')


@unittest.skipUnless(os.environ.get('RIFE_VS_PLUGIN') and os.environ.get('RIFE_SMALL_MODEL'),
                     'requires explicit plugin and model paths')
class RifePluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core=vs.core
        cls.core.num_threads=2
        cls.core.max_cache_size=128
        cls.core.std.LoadPlugin(path=os.environ['RIFE_VS_PLUGIN'])
        cls.model=Path(os.environ['RIFE_SMALL_MODEL']).resolve()

    def source(self):
        width=height=128
        frames=[(self.model/'fixture'/f'frame{i}.f32').read_bytes() for i in range(2)]
        blank=self.core.std.BlankClip(width=width,height=height,length=2,format=vs.RGBS,fpsnum=24000,fpsden=1001)
        def fill(n,f):
            out=f.copy()
            for c in range(3):
                start=c*width*height*4
                for y in range(height):
                    row=frames[n][start+y*width*4:start+(y+1)*width*4]
                    ctypes.memmove(out.get_write_ptr(c).value+y*out.get_stride(c),row,len(row))
            for k,v in {'_Matrix':0,'_Primaries':1,'_Transfer':1,'_Range':1,'_FieldBased':0,
                        '_DurationNum':1001,'_DurationDen':24000}.items():out.props[k]=v
            return out
        return self.core.std.ModifyFrame(blank,clips=blank,selector=fill)

    def interpolate(self,clip):
        return self.core.tigerest.RIFE(clip,model_path=str(self.model),fps_num=24000,fps_den=1001)

    def values(self,frame):
        result=array('f')
        for c in range(3):
            for y in range(frame.height):
                result.frombytes(ctypes.string_at(frame.get_read_ptr(c).value+y*frame.get_stride(c),frame.width*4))
        return result

    def test_real_middle_frame_reference_and_exact_duration(self):
        source=self.source(); output=self.interpolate(source)
        self.assertEqual((output.num_frames,output.fps_num,output.fps_den),(4,48000,1001))
        original=self.values(source.get_frame(0)); even=self.values(output.get_frame(0))
        self.assertEqual(original,even)
        middle=output.get_frame(1)
        self.assertEqual(middle.props['_TigerestRifeSynthesized'],1)
        actual=self.values(middle);reference=array('f',(self.model/'fixture/reference.f32').read_bytes())
        errors=[a-b for a,b in zip(actual,reference)]
        self.assertTrue(all(math.isfinite(v) for v in actual))
        self.assertLessEqual(sum(abs(x) for x in errors)/len(errors),.005)
        self.assertLessEqual(sum(x*x for x in errors)/len(errors),.0001)
        self.assertNotEqual(actual,original)
        self.assertEqual(self.values(output.get_frame(3)),self.values(source.get_frame(1)))
        self.assertEqual(output.get_frame(3).props['_TigerestRifeSynthesized'],0)
        total=sum((Fraction(output.get_frame(n).props['_DurationNum'],output.get_frame(n).props['_DurationDen'])
                   for n in range(4)),Fraction())
        self.assertEqual(total,Fraction(2*1001,24000))

    def test_even_denominator_rate_is_reduced(self):
        # container-fps 23.9988 arrives as 59997/2500. VapourSynth rejects an
        # unreduced doubled rate, which used to abort mpv during teardown.
        blank=self.core.std.BlankClip(width=128,height=128,length=2,format=vs.RGBS,fpsnum=59997,fpsden=2500)
        output=self.core.tigerest.RIFE(blank,model_path=str(self.model),fps_num=59997,fps_den=2500)
        self.assertEqual((output.num_frames,output.fps_num,output.fps_den),(4,59997,1250))

    def test_hdr_unknown_and_vfr_bypass(self):
        source=self.source()
        cases=[self.core.std.SetFrameProps(source,_Transfer=16),
               self.core.std.RemoveFrameProps(source,props=['_Transfer']),
               self.core.std.SetFrameProps(source,_DurationNum=1,_DurationDen=30)]
        for clip in cases:
            with self.subTest(clip=clip):
                f=self.interpolate(clip).get_frame(1)
                self.assertEqual(f.props['_TigerestRifeSynthesized'],0)
                self.assertEqual(self.values(f),self.values(clip.get_frame(0)))
                self.assertTrue(f.props['_TigerestRifeReason'])

    def test_cut_does_not_blend_shots(self):
        a=self.core.std.BlankClip(self.source(),length=1,color=[0,0,0])
        b=self.core.std.BlankClip(a,color=[1,1,1])
        clip=self.core.std.SetFrameProps(a+b,_Matrix=0,_Primaries=1,_Transfer=1,_Range=1,
                                      _FieldBased=0,_DurationNum=1001,_DurationDen=24000)
        f=self.interpolate(clip).get_frame(1)
        self.assertEqual(f.props['_TigerestRifeSynthesized'],0)
        self.assertEqual(f.props['_TigerestRifeReason'],'cut')
        self.assertTrue(all(x==0 for x in self.values(f)))

if __name__=='__main__':unittest.main()
