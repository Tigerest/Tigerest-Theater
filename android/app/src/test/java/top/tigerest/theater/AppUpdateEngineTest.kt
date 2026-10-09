package top.tigerest.theater

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executor

class AppUpdateEngineTest {
    private class Queue : Executor {
        val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.add(command) }
        fun run() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private class Source : AppUpdateSource {
        var bytes = "abc"
        var error = false
        var duringDownload: () -> Unit = {}
        // Scripted attempts receive the kept file; the default attempt writes the whole package.
        val attempts = ArrayDeque<(File) -> Unit>()
        val offsets = mutableListOf<Long>()
        override fun releases(): JSONArray {
            if (error) throw IllegalStateException("暂时无法连接更新服务")
            return JSONArray("""[{"tag_name":"v2.5.0","draft":false,"prerelease":false,"html_url":"https://github.com/Tigerest/Tigerest-Theater/releases/tag/v2.5.0","body":"Fixed","assets":[{"name":"TigerestTheater-2.5.0-android.apk","state":"uploaded","size":3,"digest":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","browser_download_url":"https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.5.0/TigerestTheater-2.5.0-android.apk"}]}]""")
        }
        override fun download(candidate: AppUpdateCandidate, destination: File, cancelled: () -> Boolean, progress: (Long) -> Unit) {
            offsets.add(destination.length())
            attempts.removeFirstOrNull()?.let { attempt -> attempt(destination); progress(destination.length()); return }
            destination.writeText(bytes); progress(bytes.length.toLong()); duringDownload()
        }
        override fun validateApk(file: File, candidate: AppUpdateCandidate) {}
        override fun cancel() {}
    }
    private fun scenario(action: (AppUpdateEngine, Source, Queue, File, Array<String>, Array<Boolean>) -> Unit) {
        val source = Source(); val queue = Queue(); val directory = Files.createTempDirectory("app-updater").toFile()
        val skipped = arrayOf(""); val enabled = arrayOf(true)
        val engine = AppUpdateEngine("2.4.1", directory, source, { enabled[0] }, { skipped[0] }, { skipped[0] = it }, queue, listOf(0, 0))
        try { action(engine, source, queue, directory, skipped, enabled) } finally { engine.close(); directory.deleteRecursively() }
    }
    private val partName = "update-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.part"
    private val stall: (File) -> Unit = { throw IOException("stalled") }
    private fun append(text: String, then: (File) -> Unit = {}): (File) -> Unit = { file -> file.appendText(text); then(file) }

    @Test fun automaticCheckRunsOnceWhileManualBypassesDisabledAndSkipped() = scenario { engine, _, queue, _, skipped, enabled ->
        enabled[0] = false
        engine.check(false); queue.run(); assertEquals("idle", engine.snapshot().getString("status"))
        enabled[0] = true
        engine.check(false); queue.run(); assertEquals("idle", engine.snapshot().getString("status"))
        skipped[0] = "2.5.0"
        engine.check(true); queue.run(); assertEquals("available", engine.snapshot().getString("status"))
        engine.skip(); assertEquals("2.5.0", skipped[0]); assertEquals("idle", engine.snapshot().getString("status"))
        engine.check(true); queue.run(); assertEquals("available", engine.snapshot().getString("status"))
    }

    @Test fun automaticSkipsPersistedVersionAndManualRetriesNetworkFailure() = scenario { engine, source, queue, _, skipped, _ ->
        skipped[0] = "2.5.0"
        engine.check(false); queue.run(); assertEquals("current", engine.snapshot().getString("status"))
        source.error = true
        engine.check(true); queue.run(); assertEquals("error", engine.snapshot().getString("status"))
        source.error = false
        engine.check(true); queue.run(); assertEquals("available", engine.snapshot().getString("status"))
    }

    @Test fun manualCheckAlsoSatisfiesAutomaticCheckAfterNavigation() = scenario { engine, source, queue, _, _, _ ->
        engine.check(true); queue.run(); engine.defer()
        source.error = true
        engine.check(false); queue.run()
        assertEquals("available", engine.snapshot().getString("status"))
        assertTrue(engine.snapshot().getBoolean("deferred"))
        // Explicit checks still retry the network in the same process.
        engine.check(true); queue.run()
        assertEquals("error", engine.snapshot().getString("status"))
    }

    @Test fun cancellationDropsLateCompletionAndAllowsRetry() = scenario { engine, source, queue, directory, _, _ ->
        engine.check(true); queue.run()
        source.duringDownload = { engine.cancel() }
        engine.download(); queue.run(); assertEquals("available", engine.snapshot().getString("status"))
        // The partial package is kept, so downloading again resumes it.
        assertEquals(listOf(partName), directory.list()!!.toList())
        source.duringDownload = {}
        engine.download(); queue.run(); assertEquals("ready", engine.snapshot().getString("status"))
        assertEquals(3L, engine.snapshot().getLong("received"))
    }

    @Test fun rejectsBadHashAndRechecksBytesImmediatelyBeforeInstallation() = scenario { engine, source, queue, directory, _, _ ->
        engine.check(true); queue.run(); source.bytes = "abd"
        engine.download(); queue.run(); assertEquals("error", engine.snapshot().getString("status")); assertTrue(directory.listFiles()!!.isEmpty())
        source.bytes = "abc"
        engine.download(); queue.run(); assertEquals("ready", engine.snapshot().getString("status"))
        directory.listFiles()!!.single().writeText("abd")
        var launched = false
        engine.prepareInstall { launched = true }; queue.run()
        assertFalse(launched); assertEquals("error", engine.snapshot().getString("status"))
        assertTrue(directory.listFiles()!!.isEmpty())
    }

    @Test fun deferredStateSurvivesSnapshotsAndManualActionClearsIt() = scenario { engine, _, queue, _, _, _ ->
        engine.check(false); queue.run(); engine.defer()
        assertTrue(engine.snapshot().getBoolean("deferred"))
        engine.check(true); queue.run(); assertFalse(engine.snapshot().getBoolean("deferred"))
        engine.defer(); engine.download(); queue.run(); assertFalse(engine.snapshot().getBoolean("deferred"))
        engine.prepareInstall {}; queue.run()
        engine.installationReturned("安装未完成，可以再次点击安装")
        assertEquals("ready", engine.snapshot().getString("status"))
        assertTrue(engine.snapshot().getString("error").isNotEmpty())
    }

    @Test fun explicitDownloadAfterAutomaticCheckShowsProgressAndErrors() = scenario { engine, source, queue, _, _, _ ->
        engine.check(false); queue.run()
        assertFalse(engine.snapshot().getBoolean("manual"))
        source.bytes = "abd"
        engine.download()
        assertEquals("downloading", engine.snapshot().getString("status"))
        assertTrue(engine.snapshot().getBoolean("manual"))
        queue.run()
        assertEquals("error", engine.snapshot().getString("status"))
        assertTrue(engine.snapshot().getBoolean("manual"))
    }

    @Test fun installIntentSurvivesPageObserverReplacementAndIsConsumedExactlyOnce() = scenario { engine, _, queue, _, _, _ ->
        engine.check(false); queue.run(); engine.download()
        assertTrue(engine.snapshot().optBoolean("installAfterDownload"))
        // A replacement WebView document recovers from the same native model snapshot.
        engine.changed = {}
        engine.check(false)
        assertTrue(engine.snapshot().optBoolean("installAfterDownload"))
        queue.run()
        val recovered = engine.snapshot()
        assertEquals("ready", recovered.getString("status"))
        assertTrue(recovered.getBoolean("installAfterDownload"))
        var handoffs = 0
        var consumedBeforeSignal = false
        engine.changed = { state -> if (state.getString("status") == "installing") consumedBeforeSignal = !state.getBoolean("installAfterDownload") }
        assertTrue(engine.prepareInstall(true) { handoffs++ })
        assertTrue(consumedBeforeSignal)
        assertFalse(engine.prepareInstall(true) { handoffs++ })
        queue.run(); assertEquals(1, handoffs)
        engine.installationReturned("安装已取消")
        // A delayed ready event from the previous page must not reopen the installer.
        assertFalse(engine.prepareInstall(true) { handoffs++ })
        queue.run(); assertEquals(1, handoffs)
        assertTrue(engine.prepareInstall(false) { handoffs++ })
        queue.run(); assertEquals(2, handoffs)
    }

    @Test fun cancelAndDownloadFailureClearInstallIntent() = scenario { engine, source, queue, _, _, _ ->
        engine.check(true); queue.run(); engine.download()
        assertTrue(engine.snapshot().optBoolean("installAfterDownload"))
        engine.cancel(); queue.run()
        assertFalse(engine.snapshot().getBoolean("installAfterDownload"))
        source.bytes = "abd"
        engine.download(); queue.run()
        assertEquals("error", engine.snapshot().getString("status"))
        assertFalse(engine.snapshot().getBoolean("installAfterDownload"))
        engine.check(true); queue.run()
        assertFalse(engine.snapshot().getBoolean("installAfterDownload"))
    }

    @Test fun interruptedDownloadResumesKeptPrefixAutomatically() = scenario { engine, source, queue, directory, _, _ ->
        File(directory, "update-1.9.0-old.part").writeText("old")
        engine.check(true); queue.run()
        source.attempts += listOf(append("a", stall), append("bc"))
        engine.download(); queue.run()
        assertEquals("ready", engine.snapshot().getString("status"))
        assertEquals(listOf(0L, 1L), source.offsets)
        assertEquals("", engine.snapshot().getString("error"))
        // Superseded partial packages are cleared; only the verified APK remains.
        assertEquals("abc", directory.listFiles()!!.single().readText())
    }

    @Test fun retriesStopWithoutProgressAndKeepPrefixForManualRetry() = scenario { engine, source, queue, directory, _, _ ->
        engine.check(true); queue.run()
        val notices = mutableListOf<String>()
        engine.changed = { state -> state.getString("error").takeIf { it.isNotEmpty() }?.let(notices::add) }
        source.attempts += listOf(append("a", stall), stall, stall)
        engine.download(); queue.run()
        assertEquals("error", engine.snapshot().getString("status"))
        assertTrue(engine.snapshot().getString("error").contains("已保留下载进度"))
        assertTrue(notices.any { it.contains("自动继续") } && notices.any { it.contains("重新连接") })
        // Progress refilled the budget, so only the two attempts without bytes were spent.
        assertEquals(listOf(0L, 1L, 1L), source.offsets)
        assertEquals("a", File(directory, partName).readText())
        source.attempts += append("bc")
        engine.download(); queue.run()
        assertEquals("ready", engine.snapshot().getString("status"))
        assertEquals(1L, source.offsets.last())
    }

    @Test fun partialPackageSurvivesRestartButNotSkip() {
        val directory = Files.createTempDirectory("app-updater").toFile()
        try {
            val source = Source(); val queue = Queue()
            val first = AppUpdateEngine("2.4.1", directory, source, { true }, { "" }, {}, queue, listOf(0))
            first.check(true); queue.run()
            source.attempts += append("a") { first.close() }
            first.download(); queue.run()
            File(directory, "update-7.apk").writeText("stale")
            val second = AppUpdateEngine("2.4.1", directory, source, { true }, { "" }, {}, queue, listOf(0))
            // Startup only drops numbered packages owned by a finished process.
            assertEquals(listOf(partName), directory.list()!!.toList())
            second.check(true); queue.run()
            second.download(); assertEquals(1L, second.snapshot().getLong("received"))
            source.attempts += append("b") { second.cancel() }
            queue.run()
            assertEquals("ab", File(directory, partName).readText())
            second.skip()
            assertTrue(directory.list()!!.isEmpty())
            second.close()
        } finally { directory.deleteRecursively() }
    }

    @Test fun skipAndCloseClearInstallIntent() = scenario { engine, _, queue, _, _, _ ->
        engine.check(true); queue.run(); engine.download(); queue.run()
        assertTrue(engine.snapshot().optBoolean("installAfterDownload"))
        engine.skip()
        assertFalse(engine.snapshot().getBoolean("installAfterDownload"))
        engine.check(true); queue.run(); engine.download()
        assertTrue(engine.snapshot().getBoolean("installAfterDownload"))
        engine.close()
        assertFalse(engine.snapshot().getBoolean("installAfterDownload"))
        queue.run()
    }
}
