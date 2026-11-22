package com.papote.charge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;

/**
 * Seule porte de la mini-appli : Papote appelle « relancer », on réécrit la limite de charge Blackview
 * (une valeur en dessous, puis la sienne). La tablette réexamine alors la charge et la rouvre si le niveau
 * est sous la limite. La limite elle-même ne change pas, et rien d'autre n'est écrit.
 */
public final class Relance extends ContentProvider {
    private static final String CLE_MAX = "bv_custom_charging_max";

    @Override
    public Bundle call(String methode, String arg, Bundle extras) {
        Bundle r = new Bundle();
        if (!"relancer".equals(methode)) {
            r.putString("erreur", "demande inconnue");
            return r;
        }
        ecrire(getContext(), r);
        return r;
    }

    /** Réécrit la limite (une valeur en dessous, puis la sienne) et note le résultat dans « r » et dans le journal. */
    static void ecrire(Context c, Bundle r) {
        try {
            int max = Settings.System.getInt(c.getContentResolver(), CLE_MAX, -1);
            r.putInt("max", max);
            if (max < 70 || max > 90) {
                r.putString("erreur", "pas de limite Blackview valable (" + max + ")");
            } else {
                Settings.System.putInt(c.getContentResolver(), CLE_MAX, max - 1);
                Settings.System.putInt(c.getContentResolver(), CLE_MAX, max);
                int relu = Settings.System.getInt(c.getContentResolver(), CLE_MAX, -1);
                if (relu != max) r.putString("erreur", "limite relue à " + relu + " au lieu de " + max);
                else r.putBoolean("ok", true);
            }
        } catch (Exception e) {
            r.putString("erreur", String.valueOf(e));
        }
        Log.w("PapoteCharge", r.getBoolean("ok") ? "limite de " + r.getInt("max") + " % réécrite"
            : "limite non réécrite : " + r.getString("erreur"));
    }

    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
