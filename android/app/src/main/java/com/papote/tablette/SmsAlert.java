package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.telephony.SmsManager;
import android.util.Log;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Alerte par SMS (tablette avec carte SIM) : plus d'internet depuis 30 minutes, puis retour d'internet.
 * Envoyée aux numéros de confiance donnés à l'installation (-Numeros). Un SMS par coupure, pas plus.
 */
final class SmsAlert {
    private static final long DELAY_MS = 30 * 60_000;

    private final Context context;
    private final SharedPreferences prefs;
    private final Wifi wifi;
    private long offlineSince;

    SmsAlert(Context context, SharedPreferences prefs, Wifi wifi) {
        this.context = context.getApplicationContext();
        this.prefs = prefs;
        this.wifi = wifi;
    }

    /** À appeler chaque minute. */
    void check() {
        String numbers = prefs.getString("alertNumbers", "");
        if (numbers.isEmpty() || !wifi.hasSim()) return;
        boolean internet;
        String ssid;
        try {
            JSONObject st = new JSONObject(wifi.status());
            internet = st.optBoolean("internet");
            ssid = st.optString("wifi");
        } catch (Exception e) {
            return;
        }
        long now = System.currentTimeMillis();
        boolean alerted = prefs.getBoolean("smsAlerted", false);
        if (internet) {
            offlineSince = 0;
            if (alerted) {
                prefs.edit().putBoolean("smsAlerted", false).apply();
                send(numbers, name() + " : internet est revenu à " + hour(now) + ".");
            }
            return;
        }
        if (offlineSince == 0) offlineSince = now;
        if (alerted || now - offlineSince < DELAY_MS) return;
        String where = ssid.isEmpty() ? "Wifi introuvable" : "Connectée au wifi « " + ssid + " » mais sans internet";
        String battery = "";
        try {
            android.os.BatteryManager bm =
                    (android.os.BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            battery = " Batterie " + bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
                    + " %" + (bm.isCharging() ? ", sur secteur." : ", pas sur secteur.");
        } catch (Exception ignored) { }
        if (send(numbers, name() + " : plus d'internet depuis " + hour(offlineSince) + ". " + where + "." + battery)) {
            prefs.edit().putBoolean("smsAlerted", true).apply();
        }
    }

    private String name() {
        String n = prefs.getString("tabletName", null);
        return "Papote" + (n == null || n.isEmpty() ? "" : " (" + n + ")");
    }

    private static String hour(long t) {
        return new SimpleDateFormat("HH'h'mm", Locale.FRANCE).format(new Date(t));
    }

    @SuppressWarnings("deprecation")
    private boolean send(String numbers, String text) {
        boolean sent = false;
        for (String n : numbers.split(",")) {
            String number = n.trim();
            if (number.isEmpty()) continue;
            try {
                SmsManager sms = SmsManager.getDefault();
                sms.sendMultipartTextMessage(number, null, sms.divideMessage(text), null, null);
                sent = true;
            } catch (Exception e) {
                Log.w("Papote", "SMS d'alerte vers " + number, e);
            }
        }
        Journal.log(context, "SMS d'alerte" + (sent ? " envoyé : " : " impossible : ") + text);
        return sent;
    }
}
