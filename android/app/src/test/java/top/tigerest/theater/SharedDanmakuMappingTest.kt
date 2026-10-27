package top.tigerest.theater

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class SharedDanmakuMappingTest {
    @Test fun existingPrivateTokenIsReadOnlyForExplicitEligibleLegacySelections() {
        val trusted="62526c3bf747439c99327ddec5fed4a8"
        val session=JSONObject().put("serverId",trusted).put("userId","fixture-user").put("token","fixture-emby").put("mappingAuth","legacy")
        var authorization=MappingAuthorization()
        var privateReads=0
        val sent=mutableListOf<Map<String,String>?>()
        val mapping=SharedDanmakuMapping({_,body,headers->
            sent.add(headers)
            MappingHttpResponse(200,hit().apply{if(JSONObject(body).has("selection"))getJSONObject("match").put("origin","manual")}.toString())
        },{authorization.legacyCredential{privateReads++;"fixture-legacy"}},sessionHeaders={authorization.headers.takeIf{it.isNotEmpty()}})
        for(code in listOf(0,200,401,403,503)){
            authorization=CommunityBridgePolicy.mappingAuthorization(session,trusted,code)
            assertEquals(MappingResult.Kind.SKIPPED,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7){true}.kind)
        }
        authorization=CommunityBridgePolicy.mappingAuthorization(session,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",404)
        assertEquals(MappingResult.Kind.SKIPPED,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7){true}.kind)
        assertEquals(0,privateReads);assertTrue(sent.isEmpty())
        authorization=CommunityBridgePolicy.mappingAuthorization(session,trusted,404)
        assertEquals(MappingResult.Kind.HIT,mapping.lookup("https://nas.tigerest.top:18446",metadata(),7){true}.kind)
        assertNull(sent.single());assertEquals(0,privateReads)
        assertEquals(MappingResult.Kind.HIT,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7){true}.kind)
        assertEquals(mapOf("Authorization" to "Bearer fixture-legacy"),sent.last());assertEquals(1,privateReads)
        session.remove("mappingAuth");authorization=CommunityBridgePolicy.mappingAuthorization(session,trusted,200)
        assertEquals(MappingResult.Kind.HIT,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7){true}.kind)
        assertEquals("fixture-emby",sent.last()!!["X-Emby-Token"]);assertFalse(sent.last()!!.containsKey("Authorization"));assertEquals(1,privateReads)
    }
    @Test fun manualSelectionInvalidatesPendingAutoLookupWithinSamePlayback() {
        val requests = DanmakuRequestGeneration()
        val autoToken = requests.playbackChanged()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val automatic = AtomicReference<MappingResult>()
        val mapping = SharedDanmakuMapping({ _,body,_ ->
            if(JSONObject(body).has("selection")) MappingHttpResponse(200,hit().apply { getJSONObject("match").put("origin","manual").put("episodeId","55555") }.toString())
            else { entered.countDown(); check(release.await(3,TimeUnit.SECONDS)); MappingHttpResponse(200,hit().toString()) }
        }, { "private-fixture-token" })
        val thread = Thread { automatic.set(mapping.lookup("https://nas.tigerest.top:18446",metadata(),autoToken,requests::isCurrent)) }
        thread.start()
        try {
            assertTrue(entered.await(3,TimeUnit.SECONDS))
            val selectionToken = requests.manualSelection(autoToken)!!
            val selected = mapping.select("https://nas.tigerest.top:18446",metadata(),"tmdb-55","55555",selectionToken,requests::isCurrent)
            assertEquals(MappingResult.Kind.HIT,selected.kind)
            release.countDown(); thread.join(3000)
            assertFalse(thread.isAlive)
            assertEquals(MappingResult.Kind.STALE,automatic.get().kind)
            assertFalse(requests.isCurrent(autoToken))
            assertNull(requests.manualSelection(autoToken))
            assertTrue(requests.isCurrent(selectionToken))
        } finally { release.countDown(); thread.join(3000) }
    }
    private fun metadata(season: Any = 2, episode: Any = 3) = JSONObject()
        .put("SeriesName", "Original 作品").put("ParentIndexNumber", season).put("IndexNumber", episode)
    private fun hit() = JSONObject().put("success", true).put("matched", true)
        .put("match", JSONObject().put("origin", "shared").put("bangumiId", "tmdb-999")
            .put("episodeId", "9988776655").put("animeTitle", "Catalog title").put("episodeTitle", "Catalog E5"))
        .put("danmaku", JSONObject().put("count", 1).put("comments", org.json.JSONArray()
            .put(JSONObject().put("p", "1,1,16777215").put("m", "Complete response"))))

    @Test fun lookupPreservesOriginalIdentityAndReturnsCompleteDanmakuWithoutAnotherGet() {
        val calls = mutableListOf<JSONObject>()
        val mapping = SharedDanmakuMapping({ _, body, credential ->
            assertNull(credential); calls.add(JSONObject(body)); MappingHttpResponse(200, hit().toString())
        }, { "private-fixture-token" })
        val result = mapping.lookup("https://nas.tigerest.top:18446", metadata(), 7) { it == 7L }
        assertEquals(MappingResult.Kind.HIT, result.kind)
        assertEquals(1, calls.size)
        assertFalse(calls[0].has("selection"))
        val source = calls[0].getJSONObject("source")
        assertEquals("Original 作品", source.getString("title"))
        assertEquals(2, source.getInt("season")); assertEquals(3, source.getInt("episode"))
        assertEquals("Complete response", result.danmaku!!.getJSONArray("comments").getJSONObject(0).getString("m"))
        assertEquals("9988776655", result.match!!.getString("episodeId"))
    }

    @Test fun onlyExplicitSelectionSendsIdsAndThePrivateCredential() {
        val calls = mutableListOf<JSONObject>()
        val mapping = SharedDanmakuMapping({ _, body, credential ->
            assertEquals(mapOf("Authorization" to "Bearer private-fixture-token"), credential)
            calls.add(JSONObject(body)); MappingHttpResponse(200, hit().apply { getJSONObject("match").put("origin","manual") }.toString())
        }, { "private-fixture-token" })
        val result = mapping.select("http://192.168.5.150:18443", metadata(), "tmdb-99", "99000005", 7) { true }
        assertEquals(MappingResult.Kind.HIT, result.kind)
        assertEquals("tmdb-99", calls.single().getJSONObject("selection").getString("bangumiId"))
        assertEquals("99000005", calls.single().getJSONObject("selection").getString("episodeId"))
        assertEquals(3, calls.single().getJSONObject("source").getInt("episode"))
    }

    @Test fun missingCredentialThirdPartyUnknownSeasonAndSpecialsNeverPostSelections() {
        var requests = 0
        val mapping = SharedDanmakuMapping({ _, _, _ -> requests++; MappingHttpResponse(503, "{}") }, { null })
        assertEquals(MappingResult.Kind.SKIPPED, mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7) { true }.kind)
        for (origin in listOf("https://api.dandanplay.net", "https://nas.tigerest.top.evil:18446", "https://u:p@nas.tigerest.top:18446", "https://nas.tigerest.top:18446/path", "http://nas.tigerest.top:18443", "http://nas.tigerest.top:18446")) {
            assertEquals(MappingResult.Kind.SKIPPED,mapping.lookup(origin,metadata(),7) { true }.kind)
        }
        for (season in listOf(-1,0,1.5,1001)) assertEquals(MappingResult.Kind.SKIPPED,mapping.lookup("https://nas.tigerest.top:18446",metadata(season),7) { true }.kind)
        val unknown = metadata().apply { remove("ParentIndexNumber") }
        assertEquals(MappingResult.Kind.SKIPPED,mapping.lookup("https://nas.tigerest.top:18446",unknown,7) { true }.kind)
        assertEquals(0, requests)
    }

    @Test fun staleSelectionsAreRejectedBeforeTransportAndLookupResponsesAfterTransport() {
        var current = 8L; var requests = 0
        val mapping = SharedDanmakuMapping({ _, _, _ -> requests++; current = 9; MappingHttpResponse(200,hit().toString()) }, { "private-fixture-token" })
        assertEquals(MappingResult.Kind.STALE,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7) { it == current }.kind)
        assertEquals(0,requests)
        assertEquals(MappingResult.Kind.STALE,mapping.lookup("https://nas.tigerest.top:18446",metadata(),8) { it == current }.kind)
        assertEquals(1,requests)
    }

    @Test fun failuresDoNotClaimSaveAndRetryAfterSuppressesPostsAcrossPlaybackChanges() {
        var time = 1000L; var requests = 0
        val mapping = SharedDanmakuMapping({ _, _, _ -> requests++; MappingHttpResponse(429,"{}","120") }, { "private-fixture-token" }, { time })
        assertEquals(MappingResult.Kind.RATE_LIMITED,mapping.select("https://nas.tigerest.top:18446",metadata(),"99","99000005",7) { true }.kind)
        assertEquals(MappingResult.Kind.RATE_LIMITED,mapping.lookup("http://192.168.5.150:18443",metadata(2,4),8) { true }.kind)
        assertEquals(1,requests)
        time += 120001
        mapping.lookup("https://nas.tigerest.top:18446",metadata(2,5),9) { true }
        assertEquals(2,requests)
    }

    @Test fun malformedOversizedAndUnmatchedResponsesUseLegacyFallback() {
        for (body in listOf("{}", "{\"success\":true,\"matched\":false}", "x".repeat(16*1024*1024+1), hit().apply { getJSONObject("match").put("episodeId","https://evil") }.toString())) {
            val mapping = SharedDanmakuMapping({ _, _, _ -> MappingHttpResponse(200,body) }, { null })
            assertEquals(MappingResult.Kind.FAILED,mapping.lookup("https://nas.tigerest.top:18446",metadata(),1) { true }.kind)
        }
    }
    @Test fun sourceAndRetryLimitsDoNotGuessOrWrap() {
        assertNull(SharedDanmakuMapping.source(metadata(2,3.5)))
        assertNull(SharedDanmakuMapping.source(metadata().put("SeriesName","a".repeat(201))))
        assertNotNull(SharedDanmakuMapping.source(metadata().put("SeriesName","作".repeat(200))))
        assertEquals(120000L,SharedDanmakuMapping.retryAfterMillis("120",0))
        assertEquals(120000L,SharedDanmakuMapping.retryAfterMillis("Thu, 01 Jan 1970 00:02:00 GMT",0))
        assertEquals(Long.MAX_VALUE,SharedDanmakuMapping.retryAfterMillis("99999999999999999999999999999999",0))
    }
}
