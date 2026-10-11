package com.strengthtrainer.offline;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class PermissionsRationaleActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        text.setPadding(32, 32, 32, 32);
        text.setTextSize(18);
        text.setText("Strength Trainer — heart-rate access\n\n"
            + "The optional connector reads Fitbit / Google Health heart-rate readings already stored in Health Connect on this phone. It does not connect directly to your Versa 4 or provide live readings.\n\n"
            + "Only heart-rate read access is requested. No health data is written to Health Connect. Reads occur when you tap Refresh or import readings for a finished workout. Imported summaries are stored privately with your workout and included when you export Excel.\n\n"
            + "Strength Trainer has no internet permission, cloud account, analytics, or automatic cloud backup. Fitbit / Google Health operates separately and its syncing may require internet.\n\n"
            + "You can revoke access in Health Connect at any time. Previously imported summaries remain in this app and in files you exported. Clearing app data or uninstalling removes this app's stored data; exported files must be deleted separately.");
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.addView(text);
        setContentView(scroll);
    }
}
