package com.papote.tablette;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.app.usage.NetworkStats;
import android.app.usage.NetworkStatsManager;
import android.content.ComponentName;
import android.content.Context;
import android.net.ConnectivityManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.List;

/**
 * Carte SIM de la tablette, pour la page « Forfaits SIM » de la famille :
 * {iccid, operateur, reseau, signal (0-4), dataMoisMo}. null s'il n'y a pas de carte SIM.
 * Papote, propriétaire de l'appareil, s'accorde l'accès à l'état du téléphone (nécessaire pour l'ICCID).
 */
final class SimInfo {
    private SimInfo() { }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    static JSONObject read(Context context) {
        try {
            DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
            if (dpm != null && dpm.isDeviceOwnerApp(context.getPackageName())) {
                dpm.setPermissionGrantState(new ComponentName(context, AdminReceiver.class), context.getPackageName(),
                        Manifest.permission.READ_PHONE_STATE, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            }
            TelephonyManager tm = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null || tm.getSimState() != TelephonyManager.SIM_STATE_READY) return null;
            JSONObject sim = new JSONObject();
            String iccid = "";
            String operator = tm.getSimOperatorName();
            try {
                SubscriptionManager sm = (SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                List<SubscriptionInfo> subs = sm == null ? null : sm.getActiveSubscriptionInfoList();
                if (subs != null && !subs.isEmpty()) {
                    SubscriptionInfo s = subs.get(0);
                    iccid = s.getIccId() == null ? "" : s.getIccId();
                    if (operator == null || operator.isEmpty()) operator = String.valueOf(s.getCarrierName());
                }
            } catch (SecurityException e) {
                Log.w("Papote", "ICCID inaccessible", e);
            }
            sim.put("iccid", iccid);
            sim.put("operateur", operator == null ? "" : operator);
            String network = "";
            try { network = networkName(tm.getDataNetworkType()); } catch (SecurityException ignored) { }
            sim.put("reseau", network);
            int level = -1;
            try { level = tm.getSignalStrength() == null ? -1 : tm.getSignalStrength().getLevel(); } catch (Exception ignored) { }
            sim.put("signal", level);
            sim.put("dataMoisMo", monthlyDataMb(context, tm));
            return sim;
        } catch (Exception e) {
            Log.w("Papote", "Carte SIM", e);
            return null;
        }
    }

    private static String networkName(int type) {
        switch (type) {
            case TelephonyManager.NETWORK_TYPE_NR: return "5G";
            case TelephonyManager.NETWORK_TYPE_LTE: return "4G";
            case TelephonyManager.NETWORK_TYPE_HSPAP:
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_HSDPA:
            case TelephonyManager.NETWORK_TYPE_HSUPA:
            case TelephonyManager.NETWORK_TYPE_UMTS: return "3G";
            case TelephonyManager.NETWORK_TYPE_EDGE:
            case TelephonyManager.NETWORK_TYPE_GPRS: return "2G";
            case TelephonyManager.NETWORK_TYPE_UNKNOWN: return "";
            default: return "autre";
        }
    }

    /** Données mobiles utilisées depuis le 1er du mois, en Mo (-1 si inconnu). */
    @SuppressWarnings({"MissingPermission", "deprecation"})
    private static long monthlyDataMb(Context context, TelephonyManager tm) {
        try {
            Calendar c = Calendar.getInstance();
            c.set(Calendar.DAY_OF_MONTH, 1);
            c.set(Calendar.HOUR_OF_DAY, 0);
            c.set(Calendar.MINUTE, 0);
            c.set(Calendar.SECOND, 0);
            NetworkStatsManager nsm = (NetworkStatsManager) context.getSystemService(Context.NETWORK_STATS_SERVICE);
            String subscriber = null;
            try { subscriber = tm.getSubscriberId(); } catch (SecurityException ignored) { }
            NetworkStats.Bucket b = nsm.querySummaryForDevice(ConnectivityManager.TYPE_MOBILE, subscriber,
                    c.getTimeInMillis(), System.currentTimeMillis());
            return (b.getRxBytes() + b.getTxBytes()) / (1024 * 1024);
        } catch (Exception e) {
            return -1;
        }
    }
}
