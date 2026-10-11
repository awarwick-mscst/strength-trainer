package com.strengthtrainer.offline;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.health.connect.HealthConnectException;
import android.health.connect.HealthConnectManager;
import android.health.connect.ReadRecordsRequestUsingFilters;
import android.health.connect.ReadRecordsResponse;
import android.health.connect.TimeInstantRangeFilter;
import android.health.connect.datatypes.DataOrigin;
import android.health.connect.datatypes.HeartRateRecord;
import android.os.OutcomeReceiver;
import org.json.JSONObject;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

// Platform Health Connect is available on Android 14+. No cloud API or credentials.
@android.annotation.TargetApi(34)
public final class HeartRateConnector {
    static final String PERMISSION = "android.permission.health.READ_HEART_RATE";
    static final String FITBIT = "com.fitbit.FitbitMobile";
    private final Activity activity;
    private final HealthConnectManager manager;

    HeartRateConnector(Activity activity) {
        this.activity = activity;
        manager = activity.getSystemService(HealthConnectManager.class);
    }

    boolean supported() { return manager != null; }
    boolean granted() { return activity.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED; }

    void read(String startText, String endText, Consumer<JSONObject> callback) {
        if (!supported()) { callback.accept(error("Health Connect is unavailable on this phone.")); return; }
        if (!granted()) { callback.accept(error("Allow heart-rate access in Health Connect first.")); return; }
        try {
            Instant start = Instant.parse(startText), end = Instant.parse(endText);
            if (!end.isAfter(start) || java.time.Duration.between(start, end).toDays() > 7) throw new IllegalArgumentException("Choose a workout shorter than seven days.");
            readPage(start, end, -1, 0, new HashMap<>(), callback);
        } catch (Exception e) { callback.accept(error("Could not read heart rate. " + e.getMessage())); }
    }

    private void readPage(Instant start, Instant end, long token, int page, Map<Instant, Long> samples, Consumer<JSONObject> callback) {
        if (page >= 100) { callback.accept(error("Too many heart-rate records. Try a shorter workout.")); return; }
        ReadRecordsRequestUsingFilters.Builder<HeartRateRecord> builder = new ReadRecordsRequestUsingFilters.Builder<>(HeartRateRecord.class)
            .addDataOrigins(new DataOrigin.Builder().setPackageName(FITBIT).build())
            .setTimeRangeFilter(new TimeInstantRangeFilter.Builder().setStartTime(start).setEndTime(end).build())
            .setPageSize(1000).setAscending(true);
        if (token != -1) builder.setPageToken(token);
        try {
            manager.readRecords(builder.build(), activity.getMainExecutor(), new OutcomeReceiver<ReadRecordsResponse<HeartRateRecord>, HealthConnectException>() {
                @Override public void onResult(ReadRecordsResponse<HeartRateRecord> response) {
                    for (HeartRateRecord record : response.getRecords()) {
                        if (!FITBIT.equals(record.getMetadata().getDataOrigin().getPackageName())) continue;
                        for (HeartRateRecord.HeartRateSample sample : record.getSamples()) {
                            Instant time = sample.getTime();
                            long bpm = sample.getBeatsPerMinute();
                            // Records may overlap the requested interval; filter individual samples.
                            if (!time.isBefore(start) && time.isBefore(end) && bpm > 0 && bpm <= 300) samples.put(time, bpm);
                        }
                    }
                    if (response.getNextPageToken() != -1) readPage(start, end, response.getNextPageToken(), page + 1, samples, callback);
                    else callback.accept(summarize(samples));
                }
                @Override public void onError(HealthConnectException exception) {
                    callback.accept(error("Health Connect could not read Fitbit data. Check access permissions and sync your watch, then try again. (" + exception.getErrorCode() + ")"));
                }
            });
        } catch (Exception e) { callback.accept(error("Could not read Health Connect. " + e.getMessage())); }
    }

    static JSONObject summarize(Map<Instant, Long> samples) {
        JSONObject result = new JSONObject();
        try {
            if (samples.isEmpty()) { result.put("latest", JSONObject.NULL); result.put("summary", JSONObject.NULL); return result; }
            long sum = 0, min = Long.MAX_VALUE, max = 0;
            Instant latest = Instant.MIN;
            for (Map.Entry<Instant, Long> sample : samples.entrySet()) {
                long bpm = sample.getValue(); sum += bpm; min = Math.min(min, bpm); max = Math.max(max, bpm);
                if (sample.getKey().isAfter(latest)) latest = sample.getKey();
            }
            result.put("latest", new JSONObject().put("bpm", samples.get(latest)).put("time", latest.toString()).put("source", FITBIT));
            result.put("summary", new JSONObject().put("averageBpm", Math.round((double) sum / samples.size())).put("minBpm", min).put("maxBpm", max).put("sampleCount", samples.size()).put("source", FITBIT));
        } catch (org.json.JSONException e) { return error("Could not summarize heart rate."); }
        return result;
    }

    static JSONObject error(String message) {
        JSONObject result = new JSONObject();
        try { result.put("error", message); } catch (org.json.JSONException ignored) { }
        return result;
    }
}
