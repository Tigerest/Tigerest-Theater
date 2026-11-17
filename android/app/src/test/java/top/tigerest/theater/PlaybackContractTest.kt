package top.tigerest.theater
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class PlaybackContractTest {
 @Test fun externalSubtitlesAreFetchedByTheirAddressAndSelectedByIt() {
  assertEquals("https://media.example/Videos/1/Subtitles/3/0/Stream.srt",PlaybackContract.externalSubtitle("#,https://media.example/Videos/1/Subtitles/3/0/Stream.srt"))
  for(value in listOf<Any?>("#,","#, ","#3","3","-1","",null,-1)) assertNull(value.toString(),PlaybackContract.externalSubtitle(value))
  val tracks = JSONArray("""[{"id":1,"type":"video"},{"id":2,"type":"sub","external":true,"external-filename":"a.srt"},{"id":3,"type":"sub","external":true,"external-filename":"b.srt"},
   {"id":4,"type":"sub","external":true,"external-filename":"a.srt"},{"id":5,"type":"sub","external":false,"external-filename":"a.srt"},{"id":6,"type":"audio","external":true,"external-filename":"a.srt"}]""")
  assertEquals("the newest copy of the file",4,PlaybackContract.externalSubtitleTrack(tracks,"a.srt"))
  assertEquals(3,PlaybackContract.externalSubtitleTrack(tracks,"b.srt"))
  assertNull("a failed fetch adds no track",PlaybackContract.externalSubtitleTrack(tracks,"c.srt"))
 }
 @Test fun aPageMessageStaysForItsOwnDuration() {
  for(missing in listOf<Any?>(null,JSONObject.NULL,"soon",Double.NaN,Double.POSITIVE_INFINITY)) assertEquals(missing.toString(),3000L,PlaybackContract.noticeMillis(missing))
  assertEquals(16000L,PlaybackContract.noticeMillis(16000)); assertEquals(1500L,PlaybackContract.noticeMillis(1500.4)); assertEquals(4700L,PlaybackContract.noticeMillis("4700"))
  assertEquals(500L,PlaybackContract.noticeMillis(0)); assertEquals(500L,PlaybackContract.noticeMillis(-3000)); assertEquals(30000L,PlaybackContract.noticeMillis(1e9))
 }
 @Test fun subtitleVerticalPositionGoesBeforeThePlacement() {
  assertEquals(PlaybackContract.SubtitleVertical("bottom",100),PlaybackContract.subtitleVertical(null,-1.0))
  assertEquals(PlaybackContract.SubtitleVertical("bottom",100),PlaybackContract.subtitleVertical("",-1.0))
  assertEquals(PlaybackContract.SubtitleVertical("top",100),PlaybackContract.subtitleVertical("top",-1.0))
  // sub-pos is measured from the top, and libass applies it to bottom-aligned text only.
  assertEquals(PlaybackContract.SubtitleVertical("bottom",80),PlaybackContract.subtitleVertical("top",80.0))
  assertEquals(PlaybackContract.SubtitleVertical("bottom",0),PlaybackContract.subtitleVertical("center",0.0))
  assertEquals(PlaybackContract.SubtitleVertical("bottom",150),PlaybackContract.subtitleVertical(null,400.0))
  // The HDR overlay: the text's bottom at (height - margin) * position / 100, inside the video.
  assertEquals(870f,PlaybackContract.subtitleTop(1000f,100f,30f,100.0),.01f)
  assertEquals(385f,PlaybackContract.subtitleTop(1000f,100f,30f,50.0),.01f)
  assertEquals(0f,PlaybackContract.subtitleTop(1000f,100f,30f,0.0),.01f)
  assertEquals(900f,PlaybackContract.subtitleTop(1000f,100f,30f,150.0),.01f)
  assertEquals("taller than the video",0f,PlaybackContract.subtitleTop(100f,200f,10f,100.0),.01f)
 }
 @Test fun sharedMusicAndTrackSelectionHaveNativeSemantics() {
  assertFalse(PlaybackContract.isVideo("music")); assertFalse(PlaybackContract.isVideo("audio")); assertTrue(PlaybackContract.isVideo("video"))
  assertEquals("1",PlaybackContract.track("#1")); assertEquals("no",PlaybackContract.track("")); assertEquals("no",PlaybackContract.track("-1")); assertEquals("2",PlaybackContract.track("2"))
 }
 @Test fun mpvBackgroundUsesAlphaBeforeRgb() {
  assertEquals("#00000000",PlaybackContract.subtitleBackground("#000000","00"))
  assertEquals("#80000000",PlaybackContract.subtitleBackground("#000000","80"))
  assertEquals("#FF000000",PlaybackContract.subtitleBackground("#000000","FF"))
 }
 @Test fun hdrOutputRedrawsOnlyTextSubtitles() {
  for(codec in listOf("hdmv_pgs_subtitle","dvd_subtitle","DVB_SUBTITLE")) assertTrue(codec,PlaybackContract.isImageSubtitle(codec))
  for(codec in listOf("ass","subrip","webvtt","mov_text")) assertFalse(codec,PlaybackContract.isImageSubtitle(codec))
 }
 @Test fun overlaySubtitlesUseMpvScale() {
  val style = PlaybackContract.SubtitleStyle(1440,55.0,3.0)
  assertEquals(110f,style.textSize,.01f); assertEquals(6f,style.border,.01f); assertEquals(44f,style.verticalMargin,.01f)
 }
 @Test fun dynamicRangeNoticeMatchesTheAppleClients() {
  val dolbyVision = PlaybackContract.ColorParams(3840,2160,"bt.2020","pq",1000.6065)
  assertEquals("HDR 输出 · 杜比视界 Profile 8\n片源 3840×2160 · BT.2020 / PQ · 母版 1000 nits\n输出 BT.2020 / PQ · 由系统按屏幕能力映射亮度",
   PlaybackContract.dynamicRangeText(dolbyVision,PlaybackContract.ColorParams(primaries="bt.2020",gamma="pq",maxLuma=10000.0),8,"bt.2446a"))
  val sdrTarget = PlaybackContract.ColorParams(primaries="display-p3",gamma="gamma2.2",maxLuma=203.0)
  assertEquals("SDR 输出 · 杜比视界 Profile 8 已色调映射（bt.2446a）\n片源 3840×2160 · BT.2020 / PQ · 母版 1000 nits\n输出 Display P3 / Gamma 2.2",
   PlaybackContract.dynamicRangeText(dolbyVision,sdrTarget,8,"bt.2446a"))
  assertEquals("SDR 输出 · HDR10 已色调映射（自动）\n片源 1920×1080 · BT.2020 / PQ\n输出 Display P3 / Gamma 2.2",
   PlaybackContract.dynamicRangeText(PlaybackContract.ColorParams(1920,1080,"bt.2020","pq"),sdrTarget,0,""))
  val sdr = PlaybackContract.ColorParams(1920,1080,"bt.709","bt.1886")
  assertEquals("SDR 播放\n片源 1920×1080 · BT.709 / BT.1886\n输出 BT.709 / BT.1886",PlaybackContract.dynamicRangeText(sdr,sdr.copy(width=0,height=0),0,"bt.2446a"))
  assertNull(PlaybackContract.dynamicRangeText(sdr,PlaybackContract.ColorParams(),0,""))
  val unknownPeak = PlaybackContract.ColorParams(3840,2160,"bt.2020","pq",10000.0)
  assertEquals("HDR 输出 · HDR10\n片源 3840×2160 · BT.2020 / PQ\n输出 BT.2020 / PQ · 由系统按屏幕能力映射亮度",PlaybackContract.dynamicRangeText(unknownPeak,unknownPeak,0,""))
  val hlg = PlaybackContract.ColorParams(primaries="bt.2020",gamma="hlg")
  assertTrue(PlaybackContract.dynamicRangeText(hlg,hlg,0,"")!!.startsWith("HDR 输出 · HLG\n"))
 }
 @Test fun hdrSurfaceKeepsTheVideoAspect() {
  assertEquals(PlaybackContract.Size(2224,1251),PlaybackContract.fit(2224,2488,16.0/9))
  assertEquals(PlaybackContract.Size(1600,1200),PlaybackContract.fit(2400,1200,4.0/3))
  assertEquals(PlaybackContract.Size(2224,2488),PlaybackContract.fit(2224,2488,0.0))
 }
 @Test fun playbackEndRecordTellsAStreamCutShortFromTheEnd() {
  assertEquals("Player ended: end of file (eof-reached) at 812.4s of 1420.0s, 607.6s left (ended before the duration)",
   PlaybackContract.endRecord("end of file (eof-reached)",812.43,1420.0,endOfFile = true))
  assertEquals("Player ended: end of file (eof-reached) at 1415.0s of 1420.0s, 5.0s left",
   PlaybackContract.endRecord("end of file (eof-reached)",1415.0,1420.0,endOfFile = true))
  // Only an end of file is early: a stop is the viewer's or the page's choice.
  assertEquals("Player ended: stop requested by media session at 60.0s of 1420.0s, 1360.0s left",
   PlaybackContract.endRecord("stop requested by media session",60.0,1420.0))
  assertEquals("Player ended: replaced by a new load at 0.0s of unknown",PlaybackContract.endRecord("replaced by a new load",0.0,null))
  assertEquals("Player ended: stop requested by web at unknown of unknown",PlaybackContract.endRecord("stop requested by web",Double.NaN,0.0))
 }
 @Test fun playbackDiagnosticRecordsSurviveTheReportSanitizer() {
  // The report drops a whole record that looks private; these must arrive intact.
  for(record in listOf(PlaybackContract.endRecord("end-file without EOF; media load or network failure",3.5,1420.0),
   PlaybackContract.endRecord("stop requested by player back button",600.0,1420.0),PlaybackContract.endRecord("stop requested by system back",1.0,2.0),
   "Video output rebuilt for surface 1080x2400","Video surface attached","Video surface detached","Audio focus lost (-2), pausing",
   "Audio focus regained, resuming","Media session play","Media session pause","Web hid the video view during playback",
   "Audio output became noisy (headphones or Bluetooth disconnected), pausing",
   "External subtitle requested","Player waits up to 10 s for its external subtitle","External subtitle still loading after 10 s; starting playback without it",
   "External subtitle loaded","External subtitle failed after playback started","Intro marker set (button)","Intro marker set (automatic skip)",
   "Intro marker cleared","Intro skipped (button)","Intro skipped (automatic)"))
   assertEquals(record,ReportLogSanitizer.sanitize(record))
 }
}
