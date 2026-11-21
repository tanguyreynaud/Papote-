package com.papote.charge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;

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
        try {
            int max = Settings.System.getInt(getContext().getContentResolver(), CLE_MAX, -1);
            r.putInt("max", max);
            if (max < 70 || max > 90) {
                r.putString("erreur", "pas de limite Blackview valable (" + max + ")");
                return r;
            }
            Settings.System.putInt(getContext().getContentResolver(), CLE_MAX, max - 1);
            Settings.System.putInt(getContext().getContentResolver(), CLE_MAX, max);
            int relu = Settings.System.getInt(getContext().getContentResolver(), CLE_MAX, -1);
            if (relu != max) r.putString("erreur", "limite relue à " + relu + " au lieu de " + max);
            else r.putBoolean("ok", true);
        } catch (Exception e) {
            r.putString("erreur", String.valueOf(e));
        }
        return r;
    }

    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
