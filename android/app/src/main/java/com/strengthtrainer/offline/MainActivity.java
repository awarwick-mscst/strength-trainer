package com.strengthtrainer.offline;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int SAVE_EXCEL = 1;
    private WebView webView;
    private boolean exporting;
    private boolean destroyed;
    private static final int HEART_RATE_PERMISSION = 2;

    // Only bundled assets are loaded; every external request/navigation is blocked.
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        exporting = savedInstanceState != null && savedInstanceState.getBoolean("exporting");
        getWindow().setStatusBarColor(0xff101418);
        getWindow().setNavigationBarColor(0xff101418);
        webView = new WebView(this);
        webView.setBackgroundColor(0xff101418);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.addJavascriptInterface(new LocalStorage(), "AndroidStorage");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!isLocal(uri)) return blocked();
                String file = uri.getPath().substring(1);
                if (file.isEmpty()) file = "index.html";
                if (file.contains("..") || file.contains("/") || file.contains("\\")) return blocked();
                String mime = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "application/json";
                try { return new WebResourceResponse(mime, "UTF-8", getAssets().open(file)); }
                catch (Exception e) { return blocked(); }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton("Discard", (dialog, which) -> result.confirm())
                    .setNegativeButton("Keep workout", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }
        });
        setContentView(webView);
        webView.loadUrl("https://" + HOST + "/index.html");
    }

    private boolean isLocal(Uri uri) { return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()); }
    private WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, new ByteArrayInputStream(new byte[0]));
    }

    private class LocalStorage {
        private final SharedPreferences prefs = getSharedPreferences("workouts", MODE_PRIVATE);
        @JavascriptInterface public String getItem(String key) { return prefs.getString(key, null); }
        @JavascriptInterface public boolean setItem(String key, String value) { return prefs.edit().putString(key, value).commit(); }
        @JavascriptInterface public boolean removeItem(String key) { return prefs.edit().remove(key).commit(); }
        @JavascriptInterface public boolean commitWorkout(String key, String value) {
            return prefs.edit().putString(key, value).remove("st-session").commit();
        }
        @JavascriptInterface public String heartRateStatus() {
            boolean supported = android.os.Build.VERSION.SDK_INT >= 34 && new HeartRateConnector(MainActivity.this).supported();
            boolean granted = supported && new HeartRateConnector(MainActivity.this).granted();
            return "{\"supported\":" + supported + ",\"granted\":" + granted + "}";
        }
        @JavascriptInterface public void connectHeartRate() {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT < 34) { notifyUser("Heart-rate access requires Android 14 or newer."); return; }
                requestPermissions(new String[]{HeartRateConnector.PERMISSION}, HEART_RATE_PERMISSION);
            });
        }
        @JavascriptInterface public void manageHeartRateAccess() {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT < 34) return;
                try {
                    Intent intent = new Intent(android.health.connect.HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS);
                    intent.putExtra(Intent.EXTRA_PACKAGE_NAME, getPackageName());
                    startActivity(intent);
                } catch (Exception e) { notifyUser("Open Health Connect in your phone's settings to manage access."); }
            });
        }
        @JavascriptInterface public void readHeartRate(String id, String start, String end) {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT < 34) { heartRateResult(id, "{\"error\":\"Heart-rate access requires Android 14 or newer.\"}"); return; }
                new HeartRateConnector(MainActivity.this).read(start, end, result -> heartRateResult(id, result.toString()));
            });
        }
        @JavascriptInterface public void exportExcel(String filename, String base64) {
            runOnUiThread(() -> {
                if (exporting) { notifyUser("An export is already open."); return; }
                try {
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    try (FileOutputStream output = new FileOutputStream(exportFile())) { output.write(bytes); }
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    intent.putExtra(Intent.EXTRA_TITLE, filename);
                    exporting = true;
                    startActivityForResult(intent, SAVE_EXCEL);
                } catch (Exception e) { exporting = false; notifyUser("Could not start export. " + e.getMessage()); }
            });
        }
    }

    private File exportFile() { return new File(getCacheDir(), "pending-export.xlsx"); }
    private void heartRateResult(String id, String json) {
        if (!destroyed) webView.evaluateJavascript("window.onHeartRateResult(" + org.json.JSONObject.quote(id) + "," + json + ")", null);
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == HEART_RATE_PERMISSION && !destroyed) webView.evaluateJavascript("window.onHeartRatePermissionChanged()", null);
    }
    private void notifyUser(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    @Override protected void onSaveInstanceState(Bundle out) {
        out.putBoolean("exporting", exporting);
        super.onSaveInstanceState(out);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SAVE_EXCEL) return;
        exporting = false;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            try (FileInputStream input = new FileInputStream(exportFile());
                 OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
                if (output == null) throw new java.io.IOException("Cannot open the selected file.");
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                notifyUser("Excel file saved.");
            } catch (Exception e) { notifyUser("Export failed. " + e.getMessage()); }
        } else notifyUser("Export canceled.");
        exportFile().delete();
    }

    @Override public void onBackPressed() {
        new AlertDialog.Builder(this).setMessage("Close Strength Trainer? Your progress is saved on this device.")
            .setPositiveButton("Close", (dialog, which) -> finish())
            .setNegativeButton("Stay", null).show();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        webView.removeJavascriptInterface("AndroidStorage");
        webView.destroy();
        super.onDestroy();
    }
}
