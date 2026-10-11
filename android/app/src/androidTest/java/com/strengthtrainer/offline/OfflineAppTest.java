package com.strengthtrainer.offline;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class OfflineAppTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;
    private WebView webView;

    private void launch() throws Exception {
        Context context = instrumentation.getTargetContext();
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(intent);
        instrumentation.runOnMainSync(() -> webView = (WebView) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0));
        long deadline = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(js("typeof state !== 'undefined' && state !== null"))) return;
            Thread.sleep(100);
        }
        fail("Bundled app did not initialize");
    }

    private String js(String expression) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> webView.evaluateJavascript(expression, value -> { result.set(value); latch.countDown(); }));
        assertTrue("JavaScript did not complete", latch.await(5, TimeUnit.SECONDS));
        return result.get();
    }

    private void waitFor(String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(js(expression))) return;
            Thread.sleep(100);
        }
        fail("Condition not reached: " + expression);
    }

    @Test public void offlineWorkflowPersistsAndExports() throws Exception {
        Context context = instrumentation.getTargetContext();
        assertTrue(context.getSharedPreferences("workouts", Context.MODE_PRIVATE).edit().clear().commit());
        // Native app runtime cannot access the internet: no INTERNET permission.
        assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED,
            context.checkCallingOrSelfPermission("android.permission.INTERNET"));
        launch();
        assertEquals("true", js("isAndroid && isLocal && state.nextWorkout.type === 'A'"));
        js("startSession(); cycleSet(0, 0)");
        assertEquals("true", js("session.timer.runningSince !== null && !!session.startedAt"));
        js("session.timer.runningSince -= 60000; saveSession()");
        instrumentation.runOnMainSync(() -> activity.finish());
        instrumentation.waitForIdleSync();
        launch();
        assertEquals("true", js("session.type === 'A' && session.exercises[0].reps[0] === 5"));
        assertEquals("true", js("StrengthTimer.elapsed(session.timer) >= 60000 && document.getElementById('workout-time').textContent !== '0:00'"));
        js("document.querySelector('.timer-button').click()");
        assertEquals("true", js("session.timer.runningSince === null"));
        instrumentation.runOnMainSync(() -> activity.finish());
        instrumentation.waitForIdleSync();
        launch();
        assertEquals("true", js("session.timer.runningSince === null && session.timer.elapsedMs >= 60000"));
        js("for (let e = 0; e < 3; e++) for (let s = 0; s < 5; s++) if (session.exercises[e].reps[s] === null) cycleSet(e, s); finishWorkout()");
        waitFor("session === null && state.nextWorkout.type === 'B'");
        assertEquals("true", js("state.lifts.squat.weight === 50 && state.lifts.bench.weight === 50"));
        String saved = context.getSharedPreferences("workouts", Context.MODE_PRIVATE).getString("strength-trainer-data-v1", null);
        assertTrue(new org.json.JSONObject(saved).getJSONArray("workouts").getJSONObject(0).getLong("durationSeconds") >= 60);
        assertNull(context.getSharedPreferences("workouts", Context.MODE_PRIVATE).getString("st-session", null));
        instrumentation.runOnMainSync(() -> activity.finish());
        instrumentation.waitForIdleSync();
        launch();
        assertEquals("true", js("state.nextWorkout.type === 'B' && state.lifts.squat.weight === 50"));
        js("tab = 'settings'; render(); document.querySelector('#view .primary-btn').click()");
        long deadline = System.currentTimeMillis() + 5000;
        java.io.File file = new java.io.File(context.getCacheDir(), "pending-export.xlsx");
        while (!file.exists() && System.currentTimeMillis() < deadline) Thread.sleep(100);
        assertTrue("Native export was not staged", file.exists());
        try (java.util.zip.ZipFile workbook = new java.util.zip.ZipFile(file)) {
            assertNotNull(workbook.getEntry("xl/workbook.xml"));
            assertNotNull(workbook.getEntry("xl/worksheets/sheet1.xml"));
        }
        // Keep the Android file picker open for manual save/cancel validation.
    }

    @Test public void heartRateSummaryAndDeniedAccessAreHandled() throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 34) return;
        java.util.Map<java.time.Instant, Long> samples = new java.util.HashMap<>();
        java.time.Instant earlier = java.time.Instant.parse("2026-10-10T10:00:00Z");
        samples.put(earlier, 80L); samples.put(earlier.plusSeconds(60), 120L);
        org.json.JSONObject result = HeartRateConnector.summarize(samples);
        assertEquals(100, result.getJSONObject("summary").getInt("averageBpm"));
        assertEquals(80, result.getJSONObject("summary").getInt("minBpm"));
        assertEquals(120, result.getJSONObject("latest").getInt("bpm"));
        assertTrue(HeartRateConnector.summarize(new java.util.HashMap<>()).isNull("summary"));
        launch();
        assertEquals("true", js("JSON.parse(AndroidStorage.heartRateStatus()).supported"));
        assertEquals("true", js("!JSON.parse(AndroidStorage.heartRateStatus()).granted"));
        js("window.heartError = null; readHeartRate(new Date(Date.now()-60000).toISOString(),new Date().toISOString()).catch(e => window.heartError=e.message)");
        waitFor("window.heartError !== null");
        assertEquals("true", js("window.heartError.includes('Allow heart-rate access')"));
        instrumentation.runOnMainSync(() -> activity.finish());
    }
}
