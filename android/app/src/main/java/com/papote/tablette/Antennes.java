package com.papote.tablette;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.ServiceState;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * Antennes mobiles que la tablette entend, jointes à l'état de la carte SIM déjà envoyé (aucune
 * requête en plus) : l'admin prévient si le signal est faible ou si l'opérateur de la SIM n'a
 * aucune antenne chez Mamie (vu le 01/11 à Poissy : SIM Lyca, seulement des antennes Orange).
 *   service  : « ok », « hors service », « urgences » (antennes d'un autre opérateur seulement), « eteint »
 *   simReseau: opérateur de la SIM (MCC-MNC, « 20820 » pour Bouygues)
 *   antennes : 6 au plus, la plus forte d'abord : {reseau (MCC-MNC), nom, type (2G/3G/4G/5G), bande, dbm, utilisee}
 * La liste des antennes demande l'accès à la position (Papote, propriétaire de l'appareil, se l'accorde) ;
 * sans lui, elle reste vide et le reste est quand même envoyé.
 */
final class Antennes {
    private static final int MAX = 6;

    private Antennes() { }

    @SuppressWarnings("MissingPermission")
    static void ajouter(Context context, TelephonyManager tm, JSONObject sim) {
        try {
            sim.put("simReseau", tm.getSimOperator() == null ? "" : tm.getSimOperator());
            sim.put("service", service(tm));
            JSONArray liste = new JSONArray();
            List<CellInfo> cellules = null;
            try {
                accorderPosition(context);
                cellules = tm.getAllCellInfo();
            } catch (SecurityException e) {
                Log.w("Papote", "Antennes : accès à la position refusé", e);
            }
            if (cellules != null) {
                // La plus forte d'abord.
                cellules.sort((a, b) -> Integer.compare(dbm(b), dbm(a)));
                for (CellInfo c : cellules) {
                    JSONObject a = antenne(c);
                    if (a == null) continue;
                    liste.put(a);
                    if (liste.length() >= MAX) break;
                }
            }
            sim.put("antennes", liste);
        } catch (Exception e) {
            Log.w("Papote", "Antennes", e);
        }
    }

    @SuppressWarnings("MissingPermission")
    private static String service(TelephonyManager tm) {
        try {
            ServiceState s = tm.getServiceState();
            if (s == null) return "";
            switch (s.getState()) {
                case ServiceState.STATE_IN_SERVICE: return "ok";
                case ServiceState.STATE_EMERGENCY_ONLY: return "urgences";
                case ServiceState.STATE_POWER_OFF: return "eteint";
                default: return "hors service";
            }
        } catch (SecurityException e) {
            return "";
        }
    }

    private static void accorderPosition(Context context) {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) return;
        dpm.setPermissionGrantState(new ComponentName(context, AdminReceiver.class), context.getPackageName(),
                Manifest.permission.ACCESS_FINE_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
    }

    private static int dbm(CellInfo c) {
        try {
            int d = c.getCellSignalStrength().getDbm();
            return d == Integer.MAX_VALUE ? Integer.MIN_VALUE : d;
        } catch (Exception e) {
            return Integer.MIN_VALUE;
        }
    }

    private static JSONObject antenne(CellInfo c) throws Exception {
        String mcc = null, mnc = null, type, nom = null;
        int bande = -1;
        if (c instanceof CellInfoLte) {
            CellIdentityLte id = ((CellInfoLte) c).getCellIdentity();
            mcc = id.getMccString(); mnc = id.getMncString(); type = "4G";
            nom = String.valueOf(id.getOperatorAlphaShort() == null ? "" : id.getOperatorAlphaShort());
            if (Build.VERSION.SDK_INT >= 30 && id.getBands().length > 0) bande = id.getBands()[0];
        } else if (c instanceof CellInfoNr) {
            CellIdentityNr id = (CellIdentityNr) ((CellInfoNr) c).getCellIdentity();
            mcc = id.getMccString(); mnc = id.getMncString(); type = "5G";
            nom = String.valueOf(id.getOperatorAlphaShort() == null ? "" : id.getOperatorAlphaShort());
            if (Build.VERSION.SDK_INT >= 30 && id.getBands().length > 0) bande = id.getBands()[0];
        } else if (c instanceof CellInfoWcdma) {
            CellIdentityWcdma id = ((CellInfoWcdma) c).getCellIdentity();
            mcc = id.getMccString(); mnc = id.getMncString(); type = "3G";
            nom = String.valueOf(id.getOperatorAlphaShort() == null ? "" : id.getOperatorAlphaShort());
        } else if (c instanceof CellInfoGsm) {
            CellIdentityGsm id = ((CellInfoGsm) c).getCellIdentity();
            mcc = id.getMccString(); mnc = id.getMncString(); type = "2G";
            nom = String.valueOf(id.getOperatorAlphaShort() == null ? "" : id.getOperatorAlphaShort());
        } else {
            return null;
        }
        int d = dbm(c);
        return new JSONObject()
                .put("reseau", mcc == null || mnc == null ? "" : mcc + mnc)
                .put("nom", nom == null ? "" : nom)
                .put("type", type)
                .put("bande", bande)
                .put("dbm", d == Integer.MIN_VALUE ? 0 : d)
                .put("utilisee", c.isRegistered());
    }

    /** Pour l'écriture Firestore (REST) de « sim » : la liste en arrayValue de mapValue. */
    static JSONObject enFirestore(JSONArray liste) throws Exception {
        JSONArray valeurs = new JSONArray();
        for (int i = 0; liste != null && i < liste.length(); i++) {
            JSONObject a = liste.getJSONObject(i);
            JSONObject f = new JSONObject()
                    .put("reseau", Firebase.string(a.optString("reseau")))
                    .put("nom", Firebase.string(a.optString("nom")))
                    .put("type", Firebase.string(a.optString("type")))
                    .put("bande", new JSONObject().put("integerValue", String.valueOf(a.optInt("bande", -1))))
                    .put("dbm", new JSONObject().put("integerValue", String.valueOf(a.optInt("dbm", 0))))
                    .put("utilisee", new JSONObject().put("booleanValue", a.optBoolean("utilisee")));
            valeurs.put(new JSONObject().put("mapValue", new JSONObject().put("fields", f)));
        }
        return new JSONObject().put("arrayValue", new JSONObject().put("values", valeurs));
    }
}
