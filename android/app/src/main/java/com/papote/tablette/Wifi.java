package com.papote.tablette;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Wifi réglé depuis l'écran de la tablette (première installation chez le client, ou plus d'internet).
 * Papote étant propriétaire de l'appareil, elle peut ajouter un réseau sans passer par les réglages d'Android.
 */
final class Wifi {
    private static final String TAG = "Papote";
    private final Context context;
    private final ComponentName admin;

    Wifi(Context context, ComponentName admin) {
        this.context = context.getApplicationContext();
        this.admin = admin;
    }

    private WifiManager wm() {
        return (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
    }

    /** La recherche des réseaux demande la localisation : on l'accorde et on l'allume (mode kiosque). */
    private void allowScan() {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) return;
        try {
            dpm.setPermissionGrantState(admin, context.getPackageName(), Manifest.permission.ACCESS_FINE_LOCATION,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            if (Build.VERSION.SDK_INT >= 30) dpm.setLocationEnabled(admin, true);
        } catch (Exception e) {
            Log.w(TAG, "Localisation pour le wifi", e);
        }
    }

    /** Réseaux autour, du plus fort au plus faible : [{ssid, secure, level}]. */
    @SuppressWarnings("deprecation")
    String scan() {
        allowScan();
        JSONArray out = new JSONArray();
        try {
            WifiManager wm = wm();
            if (!wm.isWifiEnabled()) wm.setWifiEnabled(true);
            wm.startScan();
            Map<String, ScanResult> best = new HashMap<>();
            for (ScanResult r : wm.getScanResults()) {
                if (r.SSID == null || r.SSID.isEmpty()) continue;
                ScanResult old = best.get(r.SSID);
                if (old == null || r.level > old.level) best.put(r.SSID, r);
            }
            List<ScanResult> list = new ArrayList<>(best.values());
            Collections.sort(list, (a, b) -> Integer.compare(b.level, a.level));
            for (ScanResult r : list) {
                String caps = r.capabilities == null ? "" : r.capabilities;
                out.put(new JSONObject()
                        .put("ssid", r.SSID)
                        .put("secure", caps.contains("WPA") || caps.contains("WEP") || caps.contains("SAE"))
                        .put("level", WifiManager.calculateSignalLevel(r.level, 4)));
            }
        } catch (Exception e) {
            Log.w(TAG, "Recherche des réseaux wifi", e);
        }
        return out.toString();
    }

    /** Se connecte au réseau donné (mot de passe vide : réseau ouvert). */
    @SuppressWarnings("deprecation")
    boolean connect(String ssid, String password) {
        try {
            WifiManager wm = wm();
            if (!wm.isWifiEnabled()) wm.setWifiEnabled(true);
            WifiConfiguration c = new WifiConfiguration();
            c.SSID = "\"" + ssid + "\"";
            if (password == null || password.isEmpty()) {
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            } else {
                c.preSharedKey = "\"" + password + "\"";
            }
            int id = wm.addNetwork(c);
            if (id < 0) {
                Log.w(TAG, "Réseau wifi refusé : " + ssid);
                return false;
            }
            wm.disconnect();
            boolean ok = wm.enableNetwork(id, true);
            wm.reconnect();
            return ok;
        } catch (Exception e) {
            Log.w(TAG, "Connexion wifi", e);
            return false;
        }
    }

    /** {wifi: nom du réseau ou "", internet: true/false, mobile: données mobiles disponibles} */
    @SuppressWarnings("deprecation")
    String status() {
        JSONObject j = new JSONObject();
        try {
            WifiInfo info = wm().getConnectionInfo();
            String ssid = info == null || info.getSSID() == null ? "" : info.getSSID().replace("\"", "");
            if ("<unknown ssid>".equals(ssid)) ssid = "";
            j.put("wifi", ssid);
            boolean internet = false;
            boolean mobile = false;
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) continue;
                internet = true;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) mobile = true;
            }
            j.put("internet", internet).put("mobile", mobile).put("sim", hasSim());
        } catch (Exception e) {
            Log.w(TAG, "État du réseau", e);
        }
        return j.toString();
    }

    boolean hasSim() {
        TelephonyManager tm = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        return tm != null && tm.getSimState() == TelephonyManager.SIM_STATE_READY;
    }
}
