package com.papote.tablette;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * La tablette sans tablette : la vraie synchronisation de l'appli (Sync.java) tourne ici, sur l'ordinateur,
 * et parle aux émulateurs Firebase comme elle parle à Firebase sur la tablette. Le banc Node (tablette-reelle.js)
 * tient l'écran : il reçoit ce que l'appli envoie à la page (onStatus, onPosts…) et renvoie ce que la page
 * demande à l'appli (markSeen, reply, welcomeSeen…), comme le fait MainActivity entre Sync et la WebView.
 *
 * Lancement : java … com.papote.tablette.PontTablette <port du banc> <dossier de la tablette>
 * Échanges : une ligne JSON par message. Banc → { id, cmd, args } ; ici → { id, res } ou { id, err } ;
 * événements de l'appli → { evt, data }.
 */
public final class PontTablette implements Sync.Listener {

    // ---------- Android imité : dossier de l'appli et réglages ----------

    static final class Reglages implements SharedPreferences {
        final Map<String, Object> valeurs = new HashMap<>();
        @Override public synchronized Map<String, ?> getAll() { return new HashMap<>(valeurs); }
        @Override public synchronized String getString(String k, String d) { Object v = valeurs.get(k); return v instanceof String ? (String) v : d; }
        @SuppressWarnings("unchecked")
        @Override public synchronized Set<String> getStringSet(String k, Set<String> d) { Object v = valeurs.get(k); return v instanceof Set ? new HashSet<>((Set<String>) v) : d; }
        @Override public synchronized int getInt(String k, int d) { Object v = valeurs.get(k); return v instanceof Integer ? (Integer) v : d; }
        @Override public synchronized long getLong(String k, long d) { Object v = valeurs.get(k); return v instanceof Long ? (Long) v : d; }
        @Override public synchronized float getFloat(String k, float d) { Object v = valeurs.get(k); return v instanceof Float ? (Float) v : d; }
        @Override public synchronized boolean getBoolean(String k, boolean d) { Object v = valeurs.get(k); return v instanceof Boolean ? (Boolean) v : d; }
        @Override public synchronized boolean contains(String k) { return valeurs.containsKey(k); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) { }
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) { }
        @Override public Editor edit() {
            return new Editor() {
                private final Map<String, Object> mises = new HashMap<>();
                private final Set<String> retraits = new HashSet<>();
                private boolean tout;
                private Editor mettre(String k, Object v) { if (v == null) retraits.add(k); else { mises.put(k, v); retraits.remove(k); } return this; }
                @Override public Editor putString(String k, String v) { return mettre(k, v); }
                @Override public Editor putStringSet(String k, Set<String> v) { return mettre(k, v == null ? null : new HashSet<>(v)); }
                @Override public Editor putInt(String k, int v) { return mettre(k, v); }
                @Override public Editor putLong(String k, long v) { return mettre(k, v); }
                @Override public Editor putFloat(String k, float v) { return mettre(k, v); }
                @Override public Editor putBoolean(String k, boolean v) { return mettre(k, v); }
                @Override public Editor remove(String k) { retraits.add(k); mises.remove(k); return this; }
                @Override public Editor clear() { tout = true; return this; }
                @Override public boolean commit() { apply(); return true; }
                @Override public void apply() {
                    synchronized (Reglages.this) {
                        if (tout) valeurs.clear();
                        for (String k : retraits) valeurs.remove(k);
                        valeurs.putAll(mises);
                    }
                }
            };
        }
    }

    static final class Appareil extends ContextWrapper {
        final File dossier;
        final Map<String, Reglages> reglages = new HashMap<>();
        Appareil(File dossier) { super(null); this.dossier = dossier; new File(dossier, "files").mkdirs(); new File(dossier, "cache").mkdirs(); }
        @Override public Context getApplicationContext() { return this; }
        @Override public File getFilesDir() { return new File(dossier, "files"); }
        @Override public File getCacheDir() { return new File(dossier, "cache"); }
        @Override public File getExternalFilesDir(String type) { return new File(dossier, "files"); }
        @Override public synchronized SharedPreferences getSharedPreferences(String nom, int mode) { return reglages.computeIfAbsent(nom, (k) -> new Reglages()); }
        @Override public Object getSystemService(String nom) { return null; } // ni wifi, ni batterie, ni téléphone : l'appli s'en passe
        @Override public Intent registerReceiver(android.content.BroadcastReceiver r, IntentFilter f) { return null; }
        @Override public String getPackageName() { return "com.papote.tablette"; }
        @Override public android.content.pm.PackageManager getPackageManager() { return null; }
        @Override public android.content.ContentResolver getContentResolver() { return null; }
    }

    // ---------- Le pont ----------

    private final Appareil appareil;
    private final SharedPreferences prefs;
    private final OutputStream sortie;
    private Sync sync;

    private PontTablette(File dossier, OutputStream sortie) {
        this.appareil = new Appareil(dossier);
        this.prefs = appareil.getSharedPreferences("papote", Context.MODE_PRIVATE);
        this.sortie = sortie;
    }

    private void ecrire(JSONObject o) {
        try {
            byte[] ligne = (o.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (sortie) { sortie.write(ligne); sortie.flush(); }
        } catch (Exception e) {
            System.exit(0); // le banc est parti
        }
    }

    private void evenement(String nom, JSONObject data) {
        try { ecrire(new JSONObject().put("evt", nom).put("data", data == null ? new JSONObject() : data)); } catch (Exception ignored) { }
    }

    @Override public void onStatus(JSONObject s) { evenement("onStatus", s); }
    @Override public void onPosts(JSONObject p) { evenement("onPosts", p); }
    @Override public void onWeather(JSONObject w) { evenement("onWeather", w); }
    @Override public void onNewArrival() { evenement("onNewArrival", null); }
    @Override public void onReminders(JSONObject p) { evenement("onReminders", p); }
    @Override public void onFamily(JSONObject p) { evenement("onFamily", p); }
    @Override public void onVolume(int v) { try { evenement("onVolume", new JSONObject().put("volume", v)); } catch (Exception ignored) { } }
    @Override public void onFamilyLost() { evenement("onFamilyLost", null); }
    @Override public void onDatabaseChanged(String base) { try { evenement("onDatabaseChanged", new JSONObject().put("base", base)); } catch (Exception ignored) { } }
    @Override public void onRecharger() { evenement("onRecharger", null); }

    private void demarrer() {
        sync = new Sync(appareil, prefs, this);
        sync.start();
    }

    private Object commande(String cmd, JSONArray a) throws Exception {
        switch (cmd) {
            // Vie de la tablette
            case "demarrer": if (sync == null) demarrer(); return true;
            case "arreter": if (sync != null) { sync.stop(); sync = null; } return true;
            case "redemarrer": // comme une tablette éteinte puis rallumée : réglages et fichiers gardés
                if (sync != null) sync.stop();
                demarrer();
                return true;
            case "serie": android.os.Build.SERIAL = a.getString(0); return true;
            case "compte": { // comme à l'atelier : la tablette a ses deux comptes (elle-même et ses appels) avant de partir
                Firebase f = new Firebase(appareil, prefs);
                f.token();
                f.ensureCallsAccount();
                return new JSONObject().put("uid", f.uid()).put("callsUid", f.callsUid());
            }
            case "reseau": ReseauVersEmulateurs.coupe = !a.getBoolean(0); return true;
            case "acceleration": android.os.Handler.acceleration = a.getDouble(0); return true;
            case "dossier": return appareil.getFilesDir().getAbsolutePath();
            case "reglages": return new JSONObject(((Reglages) prefs).getAll());
            case "regler": {
                Object v = a.get(1);
                SharedPreferences.Editor e = prefs.edit();
                if (v == JSONObject.NULL) e.remove(a.getString(0));
                else if (v instanceof Boolean) e.putBoolean(a.getString(0), (Boolean) v);
                else if (v instanceof Number) e.putLong(a.getString(0), ((Number) v).longValue());
                else e.putString(a.getString(0), String.valueOf(v));
                e.apply();
                return true;
            }
            case "journal": return new JSONArray(new java.util.ArrayList<>(android.util.Log.lignes));
            case "plantages": return new JSONArray(new java.util.ArrayList<>(android.os.Handler.plantages));
            case "refusees": return new JSONArray(new HashSet<>(ReseauVersEmulateurs.refusees));
            case "demandes": return ReseauVersEmulateurs.demandes.get();
            // Ce que la page demande à l'appli (MainActivity, @JavascriptInterface)
            case "ready": sync.resend(); return null;
            case "markSeen": sync.markSeen(a.getString(0), false); return null;
            case "sendHeart": sync.markSeen(a.getString(0), true); return null;
            case "reply": sync.reply(a.getString(0), a.getString(1)); return null;
            case "realtime": sync.setRealtime(a.getBoolean(0)); return null;
            case "changed": sync.poke(); return null;
            case "morePhotos": sync.morePhotos(); return null;
            case "touched": sync.touched(); return null;
            case "seen": sync.seen(); return null;
            case "ackReminder": sync.ackReminder(a.getString(0), a.getString(1)); return null;
            case "seenReminder": sync.seenReminder(a.getString(0), a.getString(1)); return null;
            case "getCode": return prefs.getString("code", null);
            case "callsAccount": return sync.callsAccount();
            case "meteoChoose": sync.setMeteo(a.getString(0), a.getDouble(1), a.getDouble(2)); return null;
            case "meteoSkip": sync.setMeteo(null, 0, 0); return null;
            case "wifiDone": sync.wifiDone(); return null;
            case "welcomeBack": sync.welcomeBack(a.getBoolean(0)); return null;
            case "welcomeSeen": sync.welcomeSeen(); return null;
            case "getPairing": return sync.pairingCode();
            case "firestoreDatabase": return Firebase.database();
            case "simBudget": return Forfait.etat(appareil).toString();
            case "paused": return sync.paused();
            case "perdue": return sync.perdue();
            case "isNight": return Veille.isNight(appareil);
            default: throw new IllegalArgumentException("commande inconnue : " + cmd);
        }
    }

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        File dossier = new File(args[1]);
        ReseauVersEmulateurs.projet = System.getProperty("pont.projet", ReseauVersEmulateurs.projet);
        ReseauVersEmulateurs.firestore = System.getProperty("pont.firestore", ReseauVersEmulateurs.firestore);
        ReseauVersEmulateurs.comptes = System.getProperty("pont.comptes", ReseauVersEmulateurs.comptes);
        ReseauVersEmulateurs.fichiers = System.getProperty("pont.fichiers", ReseauVersEmulateurs.fichiers);
        ReseauVersEmulateurs.fonctions = System.getProperty("pont.fonctions", "");
        ReseauVersEmulateurs.installer();
        Socket s = new Socket("127.0.0.1", port);
        PontTablette pont = new PontTablette(dossier, s.getOutputStream());
        BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
        pont.evenement("pret", null);
        String ligne;
        while ((ligne = in.readLine()) != null) {
            JSONObject q = new JSONObject(ligne);
            JSONObject r = new JSONObject().put("id", q.getInt("id"));
            try {
                Object res = pont.commande(q.getString("cmd"), q.optJSONArray("args") == null ? new JSONArray() : q.getJSONArray("args"));
                r.put("res", res == null ? JSONObject.NULL : res);
            } catch (Throwable t) {
                r.put("err", String.valueOf(t));
            }
            pont.ecrire(r);
        }
        System.exit(0);
    }
}
