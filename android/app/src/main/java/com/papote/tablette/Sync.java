package com.papote.tablette;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Récupère régulièrement les envois de la famille et la météo, en arrière-plan.
 * Les photos sont enregistrées en fichiers pour ne pas faire transiter de gros textes vers la page.
 */
final class Sync {
    interface Listener {
        void onStatus(JSONObject status);
        void onPosts(JSONObject payload);
        void onWeather(JSONObject weather);
        /** Un nouvel envoi vient d'arriver (pas au premier chargement). */
        void onNewArrival();
        void onReminders(JSONObject payload);
        /** Photos de profil des membres et anniversaires. */
        void onFamily(JSONObject payload);
        /** Volume réglé depuis l'app famille (0-100), -1 si aucun réglage. */
        default void onVolume(int volume) { }
        /** La tablette n'est plus dans sa famille : la page oublie la famille des appels. */
        default void onFamilyLost() { }
        /** La base Firestore a changé (migration) : la page doit se recharger pour la suivre. */
        default void onDatabaseChanged(String database) { }
    }

    private static final String TAG = "PapoteSync";
    private static final long POLL_MS = 20_000;               // nouveaux envois
    private static final long FULL_REFRESH_MS = 6 * 3600_000; // relecture complète de sécurité
    private static final long REALTIME_POLL_MS = 10 * 60_000; // quand la page reçoit les changements en direct
    private static final long WEATHER_MS = 30 * 60_000;
    private static final long REMINDERS_MS = 6 * 3600_000;
    private static final int MAX_POSTS = 60;
    // Tablettes déjà reliées avant le choix de la ville : la météo de Saint-Martin-de-Valamas, comme avant.
    private static final String LEGACY_CITY = "Saint-Martin-de-Valamas";
    private static final double LEGACY_LAT = 44.9372;
    private static final double LEGACY_LON = 4.3687;

    static final class Post {
        String id;
        String type;
        String text;
        String authorName;
        String authorUid;
        String imageUrl;
        String videoUrl;
        String createdAtRaw;
        long createdAt;
        long seenAt;
        long hearts;
        String imagePath;
        String audioPath;
        String videoPath;
        /** Voix Google du texte (functions/voix.js) : adresse en ligne, puis fichier local. */
        String voiceUrl;
        String voicePath;
        /** Annonce « Julie vous écrit : » (même voix), jouée avant le texte. */
        String announceUrl;
        String announcePath;
        /** Envoi de plusieurs photos : adresses et fichiers des photos 2 à 5. */
        List<String> extraUrls = new ArrayList<>();
        List<String> extraPaths = new ArrayList<>();
        long duration;
        long chunks;
        String mime;
    }

    private final SharedPreferences prefs;
    private final Firebase firebase;
    private final Http http;
    private final File imageDir;
    private final Listener listener;
    private final HandlerThread thread = new HandlerThread("papote-sync");
    private final Handler handler;

    // Accès uniquement depuis le fil de synchronisation.
    private final Map<String, Post> posts = new LinkedHashMap<>();
    private String familyName;
    private String familyCode;
    private String textSize;
    /** Statut de l'abonnement (écrit par le serveur), vide si absent. */
    private String subscription = "";
    private long lastFullRefresh;
    private long lastRev = Long.MIN_VALUE; // marqueur de changement de la famille
    private volatile boolean realtime;
    private boolean loadedOnce;
    private long lastReminders;
    private String lastRemindersJson;
    private long lastFamilyExtras;
    private String lastFamilyJson;
    private long lastWeather;
    private String lastPostsJson;
    private String lastStatusJson;
    private int photoLimit = 6;
    private final Context context;
    private boolean meteoReported;

    Sync(Context context, SharedPreferences prefs, Listener listener) {
        this.context = context.getApplicationContext();
        this.prefs = prefs;
        this.firebase = new Firebase(context, prefs);
        AppCheck.setIdToken(firebase::token);
        this.http = new Http(context);
        this.imageDir = new File(context.getFilesDir(), "photos");
        this.listener = listener;
        imageDir.mkdirs();
        Firebase.setDatabase(prefs.getString("database", null));
        Firebase.setBucket(prefs.getString("bucket", null));
        if (prefs.getString("fid", null) != null && !Meteo.done(this.context)) {
            Meteo.save(this.context, LEGACY_CITY, LEGACY_LAT, LEGACY_LON);
        }
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    void start() {
        handler.removeCallbacks(loop);
        handler.post(loop);
        watchNetwork();
    }

    /**
     * Android prévient dès qu'internet revient (réseau « validé ») : la synchronisation repart
     * aussitôt et « Pas de connexion » disparaît, sans attendre le prochain tour.
     */
    private boolean watchingNetwork;

    private void watchNetwork() {
        if (watchingNetwork || android.os.Build.VERSION.SDK_INT < 24) return;
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            cm.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
                @Override
                public void onCapabilitiesChanged(android.net.Network network, android.net.NetworkCapabilities caps) {
                    if (caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                            && "offline".equals(lastState)) {
                        handler.removeCallbacks(loop);
                        handler.post(loop);
                    }
                }
            });
            watchingNetwork = true;
        } catch (Exception e) {
            Log.w(TAG, "Surveillance du réseau", e);
        }
    }

    /** Nouveau code tablette donné par ADB : on oublie la famille actuelle. */
    void reset() {
        handler.post(() -> {
            // Tablette encore sur un ancien compte anonyme : elle passe à son compte e-mail
            // et rejoint la famille avec le nouveau code.
            firebase.forgetAnonymous();
            prefs.edit().remove("fid").apply();
            posts.clear();
            lastFullRefresh = 0;
            lastRev = Long.MIN_VALUE;
            lastPostsJson = null;
            File[] files = imageDir.listFiles();
            if (files != null) for (File f : files) f.delete();
        });
        start();
    }

    /** Renvoie à la page tout l'état connu (après un rechargement de la page). */
    void resend() {
        handler.post(() -> {
            if (lastStatusJson != null) {
                try { listener.onStatus(new JSONObject(lastStatusJson)); } catch (JSONException ignored) { }
            }
            lastPostsJson = null;
            publishPosts();
            lastWeather = 0;
            refreshWeather();
            lastRemindersJson = null;
            lastReminders = 0;
            lastFamilyJson = null;
            lastFamilyExtras = 0;
        });
    }

    void stop() {
        thread.quit();
    }

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            try {
                checkDatabase();
                refreshWeather();
                reportWifi();
                syncPosts();
                syncReminders();
                syncFamilyExtras();
            } catch (Exception e) {
                Log.w(TAG, "Synchronisation", e);
            }
            // Pendant l'appairage, on regarde souvent si quelqu'un a tapé le code. Hors ligne, Android
            // prévient du retour d'internet (watchNetwork) ; un essai par minute reste en secours.
            boolean offline = "offline".equals(lastState);
            handler.postDelayed(this, pairingActive() ? 4_000
                    : realtime ? (offline ? 60_000 : REALTIME_POLL_MS) : POLL_MS);
        }
    };

    /**
     * Sur les tablettes récentes, la page écoute la famille en direct (Firebase web) :
     * on n'interroge alors plus le serveur que toutes les 10 minutes, et tout de suite à chaque changement.
     */
    void setRealtime(boolean on) {
        realtime = on;
    }

    void poke() {
        handler.removeCallbacks(loop);
        handler.post(loop);
    }

    // ---------- Famille ----------

    private String familyId() throws IOException, JSONException {
        String fid = prefs.getString("fid", null);
        if (fid != null) {
            firebase.ensureCallsAccount();
            return fid;
        }
        // Code tablette : créé dans l'app famille (Réglages > Installer une tablette).
        String code = prefs.getString("code", null);
        if (code == null) {
            // Pas de code donné à l'installation : c'est le client qui relie la tablette (écran Bienvenue).
            pairingStep();
            return null;
        }
        JSONObject invite = firebase.get("invites/" + code);
        if (invite == null) {
            status("setup", "Le code tablette « " + code + " » est inconnu.");
            return null;
        }
        JSONObject inviteFields = invite.getJSONObject("fields");
        if (!"tablette".equals(Firebase.str(inviteFields, "kind"))) {
            status("setup", "Ce code est celui de la famille. Pour la tablette, créez un code dans "
                    + "l'app famille : Réglages > Installer une tablette.");
            return null;
        }
        fid = Firebase.str(inviteFields, "fid");
        String uid = firebase.uid();
        boolean member;
        try {
            member = firebase.get("families/" + fid + "/members/" + uid) != null;
        } catch (Firebase.ApiException e) {
            if (e.code != 403) throw e;
            member = false;
        }
        if (!member) {
            JSONObject fields = new JSONObject()
                    .put("name", Firebase.string("Tablette"))
                    .put("role", Firebase.string("tablette"))
                    .put("code", Firebase.string(code))
                    .put("canCall", new JSONObject().put("booleanValue", true));
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + uid))
                            .put("fields", fields))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", "joinedAt").put("setToServerValue", "REQUEST_TIME")))
                    .put("currentDocument", new JSONObject().put("exists", false));
            firebase.commit(new JSONArray().put(write));
        }
        prefs.edit().putString("fid", fid).apply();
        return fid;
    }

    /** La fiche de la tablette existe-t-elle encore ? En cas de doute (réseau), on garde la famille. */
    private boolean stillMember(String fid) {
        try {
            return firebase.get("families/" + fid + "/members/" + firebase.uid()) != null;
        } catch (Firebase.ApiException e) {
            return e.code != 403 && e.code != 404;
        } catch (Exception e) {
            return true;
        }
    }

    // ---------- Envois ----------

    private void syncPosts() throws IOException, JSONException {
        String fid;
        try {
            fid = familyId();
        } catch (IOException e) {
            status("offline", null);
            return;
        }
        if (fid == null) return;

        long now = System.currentTimeMillis();
        boolean full = true;
        JSONArray result;
        try {
            // Une seule lecture : le marqueur « rev » ne bouge que si la famille a envoyé ou supprimé
            // quelque chose (ou modifié les rappels). Sinon, rien d'autre à lire.
            JSONObject family = firebase.get("families/" + fid, "name", "rev", "code", "textSize", "abonnement", "veille", "volume", "volumeSonnerie", "meteoVille", "options", "installation");
            long rev = 0;
            JSONObject ff = family == null ? null : family.optJSONObject("fields");
            if (ff != null) {
                familyName = Firebase.str(ff, "name");
                familyCode = Firebase.str(ff, "code");
                textSize = Firebase.str(ff, "textSize");
                JSONObject ab = ff.optJSONObject("abonnement");
                JSONObject abf = ab == null || ab.optJSONObject("mapValue") == null ? null
                        : ab.getJSONObject("mapValue").optJSONObject("fields");
                String statut = abf == null ? "" : nz(Firebase.str(abf, "statut"));
                if (!statut.equals(subscription)) {
                    subscription = statut;
                    lastPostsJson = null; // la page doit l'apprendre tout de suite
                    publishPosts();
                }
                readVeille(ff);
                readVolume(ff);
                readOptions(ff);
                readInstallation(ff);
                if (Meteo.applyFamily(context, http, ff) || !meteoReported) {
                    lastWeather = 0; // nouvelle ville : la météo est relue tout de suite
                    reportMeteo(fid);
                    meteoReported = true;
                }
                rev = Firebase.integer(ff, "rev");
            }
            if (rev == lastRev && now - lastFullRefresh < FULL_REFRESH_MS) {
                status("ok", null);
                heartbeat(fid, "lastOnline");
                return;
            }
            lastRev = rev;
            runCommands(fid); // ordres envoyés depuis l'appli famille (wifi, redémarrage, état)
            lastReminders = 0; // les rappels ont peut-être changé aussi
            lastFamilyExtras = 0; // et les anniversaires
            result = firebase.runQuery("families/" + fid, postsQuery(true));
        } catch (Firebase.ApiException e) {
            // On n'oublie la famille que si la fiche de la tablette a vraiment disparu (famille
            // supprimée ou tablette retirée), jamais parce que le code famille a changé.
            if ((e.code == 403 || e.code == 404) && !stillMember(fid)) {
                // Famille supprimée (par l'admin) ou installation annulée sur le téléphone : la tablette
                // revient d'elle-même sur l'écran du code, avec un nouveau code (l'ancien jumelage ne sert plus).
                Journal.log(context, "Plus dans la famille : retour à l'écran du code");
                prefs.edit().remove("fid").remove("pairing").remove("pairingExpires").remove("pairingFait")
                        .remove("installEnCours").remove("installPar").remove("installDepuis").apply();
                posts.clear();
                subscription = "";
                lastPostsJson = null;
                lastStatusJson = null;
                lastRev = Long.MIN_VALUE;
                listener.onFamilyLost();
                poke();
                return;
            }
            status("offline", null);
            return;
        } catch (IOException e) {
            status("offline", null);
            return;
        }
        // Nouvelle tablette : « On prépare votre tablette… » jusqu'au premier envoi de la famille.
        if (prefs.getBoolean("installEnCours", false)) {
            for (int i = 0; i < result.length(); i++) {
                if (result.getJSONObject(i).optJSONObject("document") != null) { finInstallation(); break; }
            }
        }
        status("ok", null);

        Set<String> seenIds = new HashSet<>();
        boolean newArrival = false;
        for (int i = 0; i < result.length(); i++) {
            JSONObject doc = result.getJSONObject(i).optJSONObject("document");
            if (doc == null) continue;
            Post p = parse(doc);
            seenIds.add(p.id);
            Post old = posts.get(p.id);
            if (old != null) {
                p.imagePath = old.imagePath;
                p.audioPath = old.audioPath;
                p.videoPath = old.videoPath;
                p.extraPaths = old.extraPaths;
                if (p.voiceUrl == null) p.voiceUrl = old.voiceUrl;
                if (p.voiceUrl != null && p.voiceUrl.equals(old.voiceUrl)) p.voicePath = old.voicePath;
                if (p.announceUrl == null) p.announceUrl = old.announceUrl;
                if (p.announceUrl != null && p.announceUrl.equals(old.announceUrl)) p.announcePath = old.announcePath;
            } else if (loadedOnce && p.seenAt == 0 && !"reply".equals(p.type)) {
                newArrival = true;
            }
            posts.put(p.id, p);
        }
        if (full) {
            lastFullRefresh = now;
            List<String> gone = new ArrayList<>();
            for (String id : posts.keySet()) if (!seenIds.contains(id)) gone.add(id);
            for (String id : gone) {
                posts.remove(id);
                File[] files = imageDir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (f.getName().startsWith(id + ".") || f.getName().startsWith(id + "_")) f.delete();
                    }
                }
            }
        }
        loadedOnce = true;
        recupererJumelage(fid);
        downloadMedia(fid);
        downloadVideos(fid);
        downloadVoices(fid);
        publishPosts();
        if (attendUneVoix()) {
            relecturesVoix = 0;
            handler.removeCallbacks(relireVoix);
            handler.postDelayed(relireVoix, 3_000);
        }
        heartbeat(fid, "lastOnline");
        if (newArrival && !paused()) listener.onNewArrival();
    }

    private JSONObject postsQuery(boolean full) throws JSONException {
        JSONArray fields = new JSONArray();
        for (String f : new String[]{"type", "text", "authorName", "authorUid", "createdAt", "seenAt", "hearts", "duration", "chunks", "mime", "imageUrl", "videoUrl", "photos", "voix"}) {
            fields.put(new JSONObject().put("fieldPath", f));
        }
        JSONObject q = new JSONObject()
                .put("select", new JSONObject().put("fields", fields))
                .put("from", new JSONArray().put(new JSONObject().put("collectionId", "posts")));
        String newest = newestCreatedAt();
        if (full || newest == null) {
            q.put("orderBy", new JSONArray().put(order("DESCENDING")));
            q.put("limit", MAX_POSTS);
        } else {
            // Entre deux rafraîchissements complets, on ne lit que les nouveaux envois (moins de lectures).
            q.put("where", new JSONObject().put("fieldFilter", new JSONObject()
                    .put("field", new JSONObject().put("fieldPath", "createdAt"))
                    .put("op", "GREATER_THAN")
                    .put("value", new JSONObject().put("timestampValue", newest))));
            q.put("orderBy", new JSONArray().put(order("ASCENDING")));
            q.put("limit", 20);
        }
        return q;
    }

    private static JSONObject order(String direction) throws JSONException {
        return new JSONObject()
                .put("field", new JSONObject().put("fieldPath", "createdAt"))
                .put("direction", direction);
    }

    private String newestCreatedAt() {
        Post newest = null;
        for (Post p : posts.values()) {
            if (p.createdAtRaw != null && (newest == null || p.createdAt > newest.createdAt)) newest = p;
        }
        return newest == null ? null : newest.createdAtRaw;
    }

    private static Post parse(JSONObject doc) {
        JSONObject f = doc.optJSONObject("fields");
        if (f == null) f = new JSONObject();
        Post p = new Post();
        String name = doc.optString("name");
        p.id = name.substring(name.lastIndexOf('/') + 1);
        p.type = Firebase.str(f, "type");
        p.text = Firebase.str(f, "text");
        p.authorName = Firebase.str(f, "authorName");
        p.authorUid = Firebase.str(f, "authorUid");
        p.imageUrl = Firebase.str(f, "imageUrl");
        p.videoUrl = Firebase.str(f, "videoUrl");
        // photos : [{ imageUrl, storagePath, thumb }, …], la 1re étant aussi dans imageUrl.
        JSONObject photosValue = f.optJSONObject("photos");
        JSONArray items = photosValue == null || photosValue.optJSONObject("arrayValue") == null ? null
                : photosValue.optJSONObject("arrayValue").optJSONArray("values");
        if (items != null) {
            for (int i = 1; i < items.length() && i < 5; i++) {
                JSONObject map = items.optJSONObject(i) == null ? null : items.optJSONObject(i).optJSONObject("mapValue");
                JSONObject mf = map == null ? null : map.optJSONObject("fields");
                String url = mf == null ? null : Firebase.str(mf, "imageUrl");
                if (url != null) p.extraUrls.add(url);
            }
        }
        JSONObject created = f.optJSONObject("createdAt");
        p.createdAtRaw = created == null ? null : created.optString("timestampValue", null);
        p.createdAt = Firebase.parseTimestamp(p.createdAtRaw);
        p.seenAt = Firebase.timestamp(f, "seenAt");
        p.hearts = Firebase.integer(f, "hearts");
        p.duration = Firebase.integer(f, "duration");
        p.chunks = Firebase.integer(f, "chunks");
        p.mime = Firebase.str(f, "mime");
        p.voiceUrl = voixUrl(f);
        p.announceUrl = voixChamp(f, "annonce");
        return p;
    }

    /** Adresse du son « voix » d'un document (map { url, texte, nom }), ou null. */
    private static String voixUrl(JSONObject f) {
        return voixChamp(f, "url");
    }

    private static String voixChamp(JSONObject f, String champ) {
        JSONObject v = f.optJSONObject("voix");
        JSONObject vf = v == null || v.optJSONObject("mapValue") == null ? null : v.optJSONObject("mapValue").optJSONObject("fields");
        return vf == null ? null : Firebase.str(vf, champ);
    }

    /**
     * Voix Google des textes (functions/voix.js) : le son arrive quelques secondes après l'envoi, donc
     * un envoi récent sans voix est relu (champ « voix » seul), puis le fichier est gardé sur la tablette.
     * Sans voix, la page lit le texte avec la voix d'Android.
     */
    /** Envoi qui reçoit une voix du serveur : un texte, ou une photo (sans mot : le mot par défaut). */
    private static boolean aUneVoix(Post p) {
        if ("reply".equals(p.type) || "video".equals(p.type) || "voice".equals(p.type)) return false;
        return "photo".equals(p.type) || (p.text != null && !p.text.trim().isEmpty());
    }

    /**
     * La voix est créée par le serveur une ou deux secondes après l'envoi, sans changer le marqueur
     * « rev » : rien ne relance la lecture avant 10 min. On la relit donc toutes les 3 s pendant
     * 45 s après l'arrivée d'un envoi qui l'attend (Tanguy, 26/10 : voix de secours sans le prénom).
     */
    private int relecturesVoix;
    private final Runnable relireVoix = new Runnable() {
        @Override
        public void run() {
            try {
                String fid = familyId();
                if (fid == null) return;
                downloadVoices(fid);
                publishPosts();
                if (attendUneVoix() && ++relecturesVoix < 15) handler.postDelayed(this, 3_000);
            } catch (Exception e) {
                Log.w(TAG, "Relecture des voix", e);
            }
        }
    };

    private boolean attendUneVoix() {
        long now = System.currentTimeMillis();
        for (Post p : posts.values()) {
            if (aUneVoix(p) && p.voiceUrl == null && now - p.createdAt < 3 * 60_000L) return true;
        }
        return false;
    }

    private void downloadVoices(String fid) {
        long now = System.currentTimeMillis();
        int relus = 0;
        for (Post p : posts.values()) {
            if (!aUneVoix(p)) continue;
            if (p.voiceUrl == null && relus < 5 && now - p.createdAt < 10 * 60_000L) {
                relus++;
                try {
                    JSONObject doc = firebase.get("families/" + fid + "/posts/" + p.id, "voix");
                    if (doc != null && doc.optJSONObject("fields") != null) {
                        p.voiceUrl = voixUrl(doc.getJSONObject("fields"));
                        p.announceUrl = voixChamp(doc.getJSONObject("fields"), "annonce");
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Voix " + p.id, e);
                }
            }
            if (p.announceUrl != null && p.announcePath == null) {
                try {
                    File file = new File(imageDir, p.id + "_annonce.mp3");
                    if (!file.exists()) file = downloadToFile(p.announceUrl, p.id + "_annonce", "mp3");
                    p.announcePath = LocalContent.mediaUrl(file.getName());
                } catch (Exception e) {
                    Log.w(TAG, "Annonce " + p.id, e);
                }
            }
            if (p.voiceUrl == null || p.voicePath != null) continue;
            try {
                File file = new File(imageDir, p.id + "_voix.mp3");
                if (!file.exists()) file = downloadToFile(p.voiceUrl, p.id + "_voix", "mp3");
                p.voicePath = LocalContent.mediaUrl(file.getName());
            } catch (Exception e) {
                Log.w(TAG, "Voix " + p.id, e);
            }
        }
    }

    /** Télécharge les photos et les messages vocaux en fichiers locaux. */
    private void downloadMedia(String fid) {
        // Photos : seulement les plus récentes (6 au départ, 5 de plus à chaque demande du diaporama).
        List<Post> recentPhotos = new ArrayList<>();
        for (Post p : posts.values()) if ("photo".equals(p.type)) recentPhotos.add(p);
        Collections.sort(recentPhotos, (a, b) -> Long.compare(b.createdAt, a.createdAt));
        Set<String> allowed = new HashSet<>();
        for (int i = 0; i < Math.min(photoLimit, recentPhotos.size()); i++) allowed.add(recentPhotos.get(i).id);
        for (Post p : posts.values()) {
            boolean photo = "photo".equals(p.type) && p.imagePath == null
                    && (allowed.contains(p.id) || existing(p.id) != null); // déjà sur la tablette : gratuit
            boolean voice = "voice".equals(p.type) && p.audioPath == null;
            if (!photo && !voice) continue;
            String field = photo ? "image" : "audio";
            File file = existing(p.id);
            if (file == null && photo && p.imageUrl != null) {
                // Nouveau format : la photo est sur Firebase Storage, adresse https publique.
                try {
                    file = downloadToFile(p.imageUrl, p.id, "jpg");
                } catch (Exception e) {
                    Log.w(TAG, "Photo " + p.id, e);
                }
            }
            if (file == null) {
                try {
                    String dataUrl = null;
                    JSONObject media = firebase.get("families/" + fid + "/posts/" + p.id + "/media/" + field);
                    if (media != null && media.optJSONObject("fields") != null) {
                        dataUrl = Firebase.str(media.getJSONObject("fields"), "data");
                    }
                    if (dataUrl == null) {
                        JSONObject doc = firebase.get("families/" + fid + "/posts/" + p.id, field);
                        if (doc == null || doc.optJSONObject("fields") == null) continue;
                        dataUrl = Firebase.str(doc.getJSONObject("fields"), field);
                    }
                    if (dataUrl == null) continue;
                    file = new File(imageDir, p.id + "." + extension(dataUrl));
                    byte[] bytes = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
                    File tmp = new File(imageDir, p.id + ".tmp");
                    FileOutputStream out = new FileOutputStream(tmp);
                    try {
                        out.write(bytes);
                    } finally {
                        out.close();
                    }
                    if (!tmp.renameTo(file)) continue;
                } catch (Exception e) {
                    Log.w(TAG, "Média " + p.id, e);
                    continue;
                }
            }
            if (photo) p.imagePath = LocalContent.mediaUrl(file.getName());
            else p.audioPath = LocalContent.mediaUrl(file.getName());
        }
        // Envoi de plusieurs photos : les suivantes, rangées en {id}_1.jpg, {id}_2.jpg…
        for (Post p : posts.values()) {
            if (!"photo".equals(p.type) || p.extraUrls.isEmpty() || p.imagePath == null) continue;
            if (p.extraPaths.size() == p.extraUrls.size()) continue;
            List<String> paths = new ArrayList<>();
            for (int i = 0; i < p.extraUrls.size(); i++) {
                File f = new File(imageDir, p.id + "_" + (i + 1) + ".jpg");
                if (!f.exists()) {
                    try {
                        f = downloadToFile(p.extraUrls.get(i), p.id + "_" + (i + 1), "jpg");
                    } catch (Exception e) {
                        Log.w(TAG, "Photo " + p.id + " n°" + (i + 2), e);
                        break;
                    }
                }
                paths.add(LocalContent.mediaUrl(f.getName()));
            }
            p.extraPaths = paths;
        }
    }

    /** Vidéos : le base64 est découpé en posts/{id}/media/video0, video1… */
    private void downloadVideos(String fid) {
        for (Post p : posts.values()) {
            if (!"video".equals(p.type) || p.videoPath != null) continue;
            if (p.chunks <= 0 && p.videoUrl == null) continue;
            File file = existing(p.id);
            if (file == null && p.videoUrl != null) {
                // Nouveau format : jusqu'à ~30 Mo, écrit directement dans un fichier.
                try {
                    file = downloadToFile(p.videoUrl, p.id, p.mime != null && p.mime.contains("webm") ? "webm" : "mp4");
                } catch (Exception e) {
                    Log.w(TAG, "Vidéo " + p.id, e);
                }
            }
            if (file == null && p.chunks > 0) {
                try {
                    StringBuilder b64 = new StringBuilder();
                    for (int i = 0; i < p.chunks; i++) {
                        JSONObject part = firebase.get("families/" + fid + "/posts/" + p.id + "/media/video" + i);
                        if (part == null || part.optJSONObject("fields") == null) { b64 = null; break; }
                        b64.append(Firebase.str(part.getJSONObject("fields"), "data"));
                    }
                    if (b64 == null) continue;
                    byte[] bytes = Base64.decode(b64.toString(), Base64.DEFAULT);
                    String ext = p.mime != null && p.mime.contains("webm") ? "webm" : "mp4";
                    File tmp = new File(imageDir, p.id + ".tmp");
                    FileOutputStream out = new FileOutputStream(tmp);
                    try {
                        out.write(bytes);
                    } finally {
                        out.close();
                    }
                    file = new File(imageDir, p.id + "." + ext);
                    if (!tmp.renameTo(file)) continue;
                } catch (Exception e) {
                    Log.w(TAG, "Vidéo " + p.id, e);
                    continue;
                }
            }
            p.videoPath = LocalContent.mediaUrl(file.getName());
        }
    }

    /** Télécharge une adresse https dans photos/{id}.{ext}, sans tout garder en mémoire. */
    private static final long MAX_PHOTO = 20L << 20, MAX_VIDEO = 200L << 20;

    private File downloadToFile(String url, String id, String ext) throws Exception {
        // Seulement le stockage Firebase (audit du 23/10) : pas d'adresse quelconque glissée dans un envoi.
        java.net.URL u = new java.net.URL(url);
        if (!"https".equals(u.getProtocol()) || !"firebasestorage.googleapis.com".equalsIgnoreCase(u.getHost())) {
            throw new IOException("Adresse refusée : " + u.getHost());
        }
        long max = "jpg".equals(ext) ? MAX_PHOTO : MAX_VIDEO;
        javax.net.ssl.HttpsURLConnection c =
                (javax.net.ssl.HttpsURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        AppCheck.addHeader(context, c, url);
        File tmp = new File(imageDir, id + ".tmp");
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            java.io.InputStream in = c.getInputStream();
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                long total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > max) throw new IOException("Fichier trop gros (" + id + ")");
                    out.write(buf, 0, n);
                }
            } finally {
                out.close();
                in.close();
            }
        } finally {
            c.disconnect();
        }
        File file = new File(imageDir, id + "." + ext);
        if (!tmp.renameTo(file)) throw new IOException("Renommage " + id);
        return file;
    }

    private File existing(String id) {
        File[] files = imageDir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.getName().startsWith(id + ".") && !f.getName().endsWith(".tmp")) return f;
            }
        }
        return null;
    }

    private static String extension(String dataUrl) {
        if (dataUrl.startsWith("data:image")) return "jpg";
        if (dataUrl.startsWith("data:audio/mp4") || dataUrl.startsWith("data:audio/aac")) return "m4a";
        if (dataUrl.startsWith("data:audio/ogg")) return "ogg";
        if (dataUrl.startsWith("data:audio/mpeg") || dataUrl.startsWith("data:audio/mp3")) return "mp3";
        return "webm";
    }

    // ---------- Veille et réponses ----------

    private final java.util.Map<String, Long> lastHeartbeat = new java.util.HashMap<>();
    private static final long HEARTBEAT_MS = 10 * 60_000;

    /** Note sur la fiche de la tablette qu'elle est en ligne, ou que Mamie l'a touchée. */
    private void heartbeat(String fid, String field) {
        long now = System.currentTimeMillis();
        Long last = lastHeartbeat.get(field);
        // « En ligne » toutes les 10 min ; « vue » et « touchée » à la minute près, pour que la famille
        // voie tout de suite que Mamie a regardé (écritures rares : seulement quand elle est là).
        long every = "lastOnline".equals(field) ? HEARTBEAT_MS : 60_000;
        if (fid == null || (last != null && now - last < every)) return;
        try {
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            // La version de l'appli, pour le tableau de bord de la famille.
                            .put("fields", new JSONObject().put("appVersion",
                                    new JSONObject().put("stringValue", appVersion()))))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("appVersion")))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", field).put("setToServerValue", "REQUEST_TIME")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
            lastHeartbeat.put(field, now);
        } catch (Exception e) {
            Log.w(TAG, "Veille " + field, e);
        }
        if ("lastOnline".equals(field)) {
            reportBattery(fid);
            reportSim(fid);
            uploadJournal(fid, false);
        }
    }

    /**
     * Batterie et chargeur, pour que la famille soit prévenue si la tablette est débranchée.
     * Écrit à part : si les règles Firestore ne l'acceptent pas encore, le signal « en ligne » passe quand même.
     */
    private void reportBattery(String fid) {
        try {
            android.os.BatteryManager bm =
                    (android.os.BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            int level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
            boolean charging = pluggedIn(context);
            // Débranchée depuis… : l'appli famille prévient (« débranchée depuis 20 min »).
            long since = prefs.getLong("unpluggedAt", 0);
            if (charging && since != 0) { prefs.edit().remove("unpluggedAt").apply(); since = 0; }
            if (!charging && since == 0) { since = System.currentTimeMillis(); prefs.edit().putLong("unpluggedAt", since).apply(); }
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
            iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            JSONObject fields = new JSONObject()
                    .put("level", new JSONObject().put("integerValue", String.valueOf(Math.max(0, Math.min(100, level)))))
                    .put("charging", new JSONObject().put("booleanValue", charging))
                    .put("unpluggedAt", since == 0 ? new JSONObject().put("nullValue", JSONObject.NULL)
                            : new JSONObject().put("timestampValue", iso.format(new java.util.Date(since))))
                    .put("at", new JSONObject().put("timestampValue", iso.format(new java.util.Date())));
            // Santé de la batterie pour l'espace admin : état, température, cycles (Android 14+).
            Intent sticky = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (sticky != null) {
                fields.put("health", Firebase.string(healthName(
                        sticky.getIntExtra(android.os.BatteryManager.EXTRA_HEALTH, 0))));
                int t = sticky.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                if (t != Integer.MIN_VALUE) fields.put("temperature", new JSONObject().put("doubleValue", t / 10.0));
                int cycles = sticky.getIntExtra("android.os.extra.CYCLE_COUNT", -1);
                if (cycles >= 0) fields.put("cycles", new JSONObject().put("integerValue", String.valueOf(cycles)));
            }
            JSONObject battery = new JSONObject().put("mapValue", new JSONObject().put("fields", fields));
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            .put("fields", new JSONObject().put("battery", battery)))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("battery")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
        } catch (Exception e) {
            Log.w(TAG, "Batterie", e);
        }
    }

    private static String healthName(int h) {
        switch (h) {
            case android.os.BatteryManager.BATTERY_HEALTH_GOOD: return "bonne";
            case android.os.BatteryManager.BATTERY_HEALTH_OVERHEAT: return "surchauffe";
            case android.os.BatteryManager.BATTERY_HEALTH_DEAD: return "morte";
            case android.os.BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE: return "surtension";
            case android.os.BatteryManager.BATTERY_HEALTH_COLD: return "froide";
            case android.os.BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE: return "panne";
            default: return "inconnue";
        }
    }

    /**
     * Wifi en cours sur la fiche de la tablette (members/{uid}.wifi = {ssid}, ou null sans wifi),
     * écrit à chaque changement de réseau : l'appli famille l'affiche dans « Wi-Fi de la tablette ».
     */
    private String lastWifiReported = null;

    private void reportWifi() {
        String fid = prefs.getString("fid", null);
        if (fid == null) return;
        try {
            String ssid = new JSONObject(wifi().status()).optString("wifi", "");
            if (ssid.equals(lastWifiReported)) return;
            JSONObject value = ssid.isEmpty() ? new JSONObject().put("nullValue", JSONObject.NULL)
                    : new JSONObject().put("mapValue", new JSONObject().put("fields",
                            new JSONObject().put("ssid", Firebase.string(ssid))));
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            .put("fields", new JSONObject().put("wifi", value)))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("wifi")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
            lastWifiReported = ssid;
        } catch (Exception e) {
            Log.w(TAG, "Wifi sur la fiche", e);
        }
    }

    // ---------- Base Firestore : bascule vers l'Europe ----------

    private static final long DATABASE_CHECK_MS = 5 * 60_000;
    private long lastDatabaseCheck;

    /**
     * Toutes les 5 minutes, la base à utiliser est relue dans l'ancienne base (config/base.database).
     * Si elle change (migration en Europe), la tablette repart sur la nouvelle base, sans réinstallation.
     */
    private void checkDatabase() {
        long now = System.currentTimeMillis();
        if (now - lastDatabaseCheck < DATABASE_CHECK_MS) return;
        if (prefs.getString("fid", null) == null && !pairingActive()) return;
        lastDatabaseCheck = now;
        try {
            String target = firebase.targetDatabase();
            prefs.edit().putString("bucket", Firebase.bucket()).apply();
            if (target == null || target.equals(Firebase.database())) return;
            Journal.log(context, "Base Firestore : " + Firebase.database() + " -> " + target);
            prefs.edit().putString("database", target).remove("pairing").remove("pairingExpires").apply();
            Firebase.setDatabase(target);
            // Tout est relu dans la nouvelle base.
            lastRev = Long.MIN_VALUE;
            lastFullRefresh = 0;
            lastReminders = 0;
            lastFamilyExtras = 0;
            lastPostsJson = null;
            meteoReported = false;
            lastWifiReported = null;
            listener.onDatabaseChanged(target);
        } catch (Exception e) {
            Log.w(TAG, "Base Firestore", e);
        }
    }

    /** Branchée sur secteur (chargeur, USB ou sans fil). */
    static boolean pluggedIn(Context context) {
        android.content.Intent sticky = context.registerReceiver(null,
                new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
        return sticky != null && sticky.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0;
    }

    /** Chargeur branché ou débranché : la fiche de la tablette est mise à jour tout de suite. */
    void powerChanged(boolean plugged) {
        handler.post(() -> {
            if (plugged) prefs.edit().remove("unpluggedAt").apply();
            else prefs.edit().putLong("unpluggedAt", System.currentTimeMillis()).apply();
            String fid = prefs.getString("fid", null);
            if (fid != null) reportBattery(fid);
        });
    }

    private String appVersion() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /** Retire la tablette de la famille (maintenance, avant désinstallation). */
    void leave() {
        handler.post(() -> {
            String fid = prefs.getString("fid", null);
            try {
                if (fid != null && firebase.uid() != null) {
                    JSONObject write = new JSONObject().put("delete",
                            Firebase.docName("families/" + fid + "/members/" + firebase.uid()));
                    firebase.commit(new JSONArray().put(write));
                }
            } catch (Exception e) {
                Log.w(TAG, "Départ de la famille", e);
            }
            prefs.edit().remove("fid").remove("code").apply();
            posts.clear();
            lastPostsJson = null;
            status("setup", "Tablette retirée de la famille.");
        });
    }

    /**
     * Remise sur l'écran Bienvenue : la tablette oublie sa famille, son nom, son wifi validé et ses
     * comptes, puis repart comme une tablette neuve (mode kiosque et réglages gardés).
     * Sa fiche dans l'ancienne famille n'est pas supprimée ici (nettoyage par le script d'administration).
     */
    void resetToWelcome() {
        handler.post(() -> {
            Journal.log(context, "Remise sur l'écran Bienvenue");
            prefs.edit().remove("fid").remove("code").remove("pairing").remove("pairingExpires").remove("pairingFait")
                    .remove("tabletName").remove("wifiDone").apply();
            Meteo.forget(context);
            firebase.forgetAll();
            posts.clear();
            subscription = "";
            prefs.edit().remove("installEnCours").remove("installPar").remove("installDepuis").remove("bienvenueVue").apply();
            lastPostsJson = null;
            lastStatusJson = null;
            lastRev = Long.MIN_VALUE;
            File[] files = imageDir.listFiles();
            if (files != null) for (File f : files) f.delete();
            poke();
        });
    }

    String callsAccount() {
        return firebase.callsAccount();
    }

    /** Le diaporama arrive au bout des photos chargées : on en charge 5 de plus. */
    void morePhotos() {
        handler.post(() -> {
            String fid = prefs.getString("fid", null);
            if (fid == null) return;
            photoLimit += 5;
            downloadMedia(fid);
            publishPosts();
        });
    }

    void touched() {
        handler.post(() -> heartbeat(prefs.getString("fid", null), "lastActive"));
    }

    /** Visage vu par la caméra : members/{uid}.lastSeen, pour l'alerte « pas vue ce matin ». */
    void seen() {
        handler.post(() -> heartbeat(prefs.getString("fid", null), "lastSeen"));
    }

    /** Réponse toute faite de Mamie, visible dans l'app famille. */
    void reply(final String postId, final String text) {
        handler.post(() -> {
            String fid = prefs.getString("fid", null);
            if (fid == null) return;
            try {
                String id = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 20);
                JSONObject fields = new JSONObject()
                        .put("type", Firebase.string("reply"))
                        .put("text", Firebase.string(text))
                        .put("image", new JSONObject().put("nullValue", JSONObject.NULL))
                        .put("replyTo", postId == null || postId.isEmpty()
                                ? new JSONObject().put("nullValue", JSONObject.NULL) : Firebase.string(postId))
                        .put("authorUid", Firebase.string(firebase.uid()))
                        .put("authorName", Firebase.string(familyName == null ? "Tablette" : familyName))
                        .put("seenAt", new JSONObject().put("nullValue", JSONObject.NULL))
                        .put("hearts", new JSONObject().put("integerValue", "0"));
                JSONObject write = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("families/" + fid + "/posts/" + id))
                                .put("fields", fields))
                        .put("updateTransforms", new JSONArray().put(new JSONObject()
                                .put("fieldPath", "createdAt").put("setToServerValue", "REQUEST_TIME")))
                        .put("currentDocument", new JSONObject().put("exists", false));
                firebase.commit(new JSONArray().put(write));
                if (postId != null && !postId.isEmpty()) markSeen(postId, false);
            } catch (Exception e) {
                Log.w(TAG, "Réponse", e);
            }
        });
    }

    private void publishPosts() {
        try {
            List<Post> list = new ArrayList<>(posts.values());
            Collections.sort(list, (a, b) -> Long.compare(b.createdAt, a.createdAt));
            JSONArray arr = new JSONArray();
            for (Post p : list) {
                if ("reply".equals(p.type)) continue; // les réponses de Mamie ne s'affichent que chez la famille
                arr.put(new JSONObject()
                        .put("id", p.id)
                        .put("type", p.type)
                        .put("text", p.text == null ? "" : p.text)
                        .put("authorName", p.authorName == null ? "" : p.authorName)
                        .put("authorUid", p.authorUid == null ? "" : p.authorUid)
                        .put("createdAt", p.createdAt)
                        .put("seen", p.seenAt > 0)
                        .put("hearts", p.hearts)
                        .put("image", p.imagePath == null ? JSONObject.NULL : p.imagePath)
                        .put("images", new JSONArray(p.extraPaths))
                        .put("audio", p.audioPath == null ? JSONObject.NULL : p.audioPath)
                        .put("video", p.videoPath == null ? JSONObject.NULL : p.videoPath)
                        .put("voice", p.voicePath == null ? JSONObject.NULL : p.voicePath)
                        .put("announce", p.announcePath == null ? JSONObject.NULL : p.announcePath)
                        .put("duration", p.duration));
            }
            JSONObject payload = new JSONObject().put("familyName", familyName == null ? "" : familyName)
                    .put("familyCode", familyCode == null ? "" : familyCode)
                    .put("textSize", textSize == null ? "" : textSize)
                    .put("subscription", subscription)
                    .put("options", options)
                    .put("veille", new JSONObject().put("active", Veille.active(context))
                            .put("de", Veille.from(context)).put("a", Veille.to(context)))
                    .put("posts", arr);
            String json = payload.toString();
            if (json.equals(lastPostsJson)) return;
            lastPostsJson = json;
            listener.onPosts(payload);
        } catch (JSONException e) {
            Log.w(TAG, "publishPosts", e);
        }
    }

    // ---------- Actions de la tablette ----------

    void markSeen(final String id, final boolean heart) {
        handler.post(() -> {
            Post p = posts.get(id);
            String fid = prefs.getString("fid", null);
            if (p == null || fid == null) return;
            if (p.seenAt > 0 && !heart) return;
            p.seenAt = System.currentTimeMillis();
            if (heart) p.hearts++;
            publishPosts();
            try {
                JSONArray transforms = new JSONArray().put(new JSONObject()
                        .put("fieldPath", "seenAt").put("setToServerValue", "REQUEST_TIME"));
                if (heart) {
                    transforms.put(new JSONObject().put("fieldPath", "hearts")
                            .put("increment", new JSONObject().put("integerValue", "1")));
                }
                JSONObject write = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("families/" + fid + "/posts/" + id))
                                .put("fields", new JSONObject()))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray()))
                        .put("updateTransforms", transforms)
                        .put("currentDocument", new JSONObject().put("exists", true));
                firebase.commit(new JSONArray().put(write));
            } catch (Exception e) {
                Log.w(TAG, "markSeen " + id, e);
            }
        });
    }

    // ---------- Rappels ----------

    private void syncReminders() {
        String fid = prefs.getString("fid", null);
        long now = System.currentTimeMillis();
        if (fid == null || now - lastReminders < REMINDERS_MS) return;
        try {
            JSONArray docs = firebase.list("families/" + fid + "/reminders");
            JSONArray out = new JSONArray();
            for (int i = 0; i < docs.length(); i++) {
                JSONObject doc = docs.getJSONObject(i);
                JSONObject f = doc.optJSONObject("fields");
                if (f == null) continue;
                String name = doc.optString("name");
                JSONArray days = new JSONArray();
                JSONObject daysValue = f.optJSONObject("days");
                JSONArray values = daysValue == null ? null
                        : daysValue.optJSONObject("arrayValue") == null ? null
                        : daysValue.getJSONObject("arrayValue").optJSONArray("values");
                if (values != null) {
                    for (int j = 0; j < values.length(); j++) {
                        days.put(Integer.parseInt(values.getJSONObject(j).optString("integerValue", "0")));
                    }
                }
                out.put(new JSONObject()
                        .put("id", name.substring(name.lastIndexOf('/') + 1))
                        .put("title", nz(Firebase.str(f, "title")))
                        .put("kind", nz(Firebase.str(f, "kind")))
                        .put("time", nz(Firebase.str(f, "time")))
                        .put("repeat", nz(Firebase.str(f, "repeat")))
                        .put("date", nz(Firebase.str(f, "date")))
                        .put("days", days)
                        .put("lastAck", nz(Firebase.str(f, "lastAck")))
                        // Réglés par la famille, facultatifs : annonce avant l'heure (minutes, absent = 15),
                        // dernier jour d'un rappel qui se répète, pause jusqu'à un jour inclus.
                        .put("avanceMin", f.has("avanceMin") ? f.getJSONObject("avanceMin").optInt("integerValue", 15) : 15)
                        .put("finLe", nz(Firebase.str(f, "finLe")))
                        .put("enPauseJusquau", nz(Firebase.str(f, "enPauseJusquau")))
                        // Voix Google du titre (functions/voix.js), jouée en ligne ; sinon voix d'Android.
                        .put("voice", nz(voixUrl(f))));
            }
            lastReminders = now;
            JSONObject payload = new JSONObject().put("reminders", out);
            String json = payload.toString();
            if (json.equals(lastRemindersJson)) return;
            lastRemindersJson = json;
            listener.onReminders(payload);
        } catch (Exception e) {
            Log.w(TAG, "Rappels", e);
        }
    }

    // ---------- Photos de profil et anniversaires ----------

    private void syncFamilyExtras() {
        String fid = prefs.getString("fid", null);
        long now = System.currentTimeMillis();
        if (fid == null || now - lastFamilyExtras < REMINDERS_MS) return;
        lastFamilyExtras = now;
        try {
            JSONObject faces = new JSONObject();
            // Les personnes de la famille (pas les tablettes), pour l'écran « Appeler ».
            JSONArray people = new JSONArray();
            try {
                JSONArray members = firebase.list("families/" + fid + "/members");
                for (int i = 0; i < members.length(); i++) {
                    JSONObject doc = members.getJSONObject(i);
                    JSONObject f = doc.optJSONObject("fields");
                    String uid = doc.optString("name").substring(doc.optString("name").lastIndexOf('/') + 1);
                    if (f != null && !"tablette".equals(Firebase.str(f, "role"))) {
                        people.put(new JSONObject().put("uid", uid).put("name", nz(Firebase.str(f, "name"))));
                    }
                    String face = f == null ? null : Firebase.str(f, "face");
                    if (face == null || !face.startsWith("data:image")) continue;
                    String name = doc.optString("name");
                    faces.put(name.substring(name.lastIndexOf('/') + 1), face);
                }
            } catch (Exception e) {
                Log.w(TAG, "Photos de profil", e);
            }
            JSONArray birthdays = new JSONArray();
            try {
                JSONArray docs = firebase.list("families/" + fid + "/birthdays");
                for (int i = 0; i < docs.length(); i++) {
                    JSONObject doc = docs.getJSONObject(i);
                    JSONObject f = doc.optJSONObject("fields");
                    if (f == null) continue;
                    String name = doc.optString("name");
                    birthdays.put(new JSONObject()
                            .put("id", name.substring(name.lastIndexOf('/') + 1))
                            .put("name", nz(Firebase.str(f, "name")))
                            .put("day", Firebase.integer(f, "day"))
                            .put("month", Firebase.integer(f, "month"))
                            .put("year", Firebase.integer(f, "year")));
                }
            } catch (Exception e) {
                // La règle Firestore des anniversaires n'est peut-être pas encore en ligne.
                Log.w(TAG, "Anniversaires", e);
            }
            JSONObject payload = new JSONObject().put("faces", faces).put("birthdays", birthdays).put("people", people);
            String json = payload.toString();
            if (json.equals(lastFamilyJson)) return;
            lastFamilyJson = json;
            listener.onFamily(payload);
        } catch (JSONException e) {
            Log.w(TAG, "Famille", e);
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    /** Mamie a confirmé un rappel : on note la date et l'heure (heure de la tablette). */
    void ackReminder(final String id, final String when) {
        handler.post(() -> {
            String fid = prefs.getString("fid", null);
            if (fid == null) return;
            try {
                JSONObject write = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("families/" + fid + "/reminders/" + id))
                                .put("fields", new JSONObject().put("lastAck", Firebase.string(when))))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("lastAck")))
                        .put("currentDocument", new JSONObject().put("exists", true));
                firebase.commit(new JSONArray().put(write));
                lastReminders = 0; // relire pour que la famille et l'écran soient à jour
            } catch (Exception e) {
                Log.w(TAG, "ackReminder " + id, e);
            }
        });
    }

    /** Mamie a regardé le rappel (visage vu par la caméra) : « vu » pour la famille, sans dire « c'est fait ». */
    void seenReminder(final String id, final String when) {
        handler.post(() -> {
            String fid = prefs.getString("fid", null);
            if (fid == null) return;
            try {
                JSONObject write = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("families/" + fid + "/reminders/" + id))
                                .put("fields", new JSONObject().put("lastSeen", Firebase.string(when))))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("lastSeen")))
                        .put("currentDocument", new JSONObject().put("exists", true));
                firebase.commit(new JSONArray().put(write));
            } catch (Exception e) {
                Log.w(TAG, "seenReminder " + id, e);
            }
        });
    }

    // ---------- Météo ----------

    private void refreshWeather() {
        resolvePendingCity();
        long now = System.currentTimeMillis();
        if (now - lastWeather < WEATHER_MS) return;
        try {
            if (!Meteo.hasCity(context)) return; // pas encore de ville : pas de météo
            JSONObject weather = Meteo.forecast(http, Meteo.lat(context), Meteo.lon(context));
            lastWeather = now;
            listener.onWeather(weather);
        } catch (Exception e) {
            Log.w(TAG, "Météo", e);
        }
    }

    // ---------- Ordres de l'appli famille : families/{fid}/commands ----------

    private Wifi wifi;

    private Wifi wifi() {
        if (wifi == null) wifi = new Wifi(context, new android.content.ComponentName(context, AdminReceiver.class));
        return wifi;
    }

    private void runCommands(String fid) {
        try {
            JSONObject q = new JSONObject()
                    .put("from", new JSONArray().put(new JSONObject().put("collectionId", "commands")))
                    .put("where", new JSONObject().put("compositeFilter", new JSONObject()
                            .put("op", "AND")
                            .put("filters", new JSONArray()
                                    .put(eq("target", firebase.uid()))
                                    .put(eq("state", "pending")))))
                    .put("limit", 5);
            JSONArray rows = firebase.runQuery("families/" + fid, q);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject doc = rows.getJSONObject(i).optJSONObject("document");
                if (doc != null) runCommand(doc);
            }
        } catch (Exception e) {
            Log.w(TAG, "Ordres de la famille", e);
        }
    }

    private static JSONObject eq(String field, String value) throws JSONException {
        return new JSONObject().put("fieldFilter", new JSONObject()
                .put("field", new JSONObject().put("fieldPath", field))
                .put("op", "EQUAL")
                .put("value", new JSONObject().put("stringValue", value)));
    }

    private void runCommand(JSONObject doc) throws IOException, JSONException {
        JSONObject f = doc.getJSONObject("fields");
        String type = nz(Firebase.str(f, "type"));
        boolean ok = true;
        String result;
        boolean reboot = false;
        if ("wifi".equals(type)) {
            String ssid = nz(Firebase.str(f, "ssid"));
            ok = !ssid.isEmpty() && wifi().connect(ssid, nz(Firebase.str(f, "password")));
            result = ok ? "La tablette se connecte au wifi « " + ssid + " »." : "Le wifi « " + ssid + " » n'a pas pu être ajouté.";
        } else if ("wifiScan".equals(type)) {
            // Réseaux autour de la tablette, pour que la famille choisisse le wifi à distance.
            JSONArray nets = new JSONArray(wifi().scan());
            JSONArray list = new JSONArray();
            for (int i = 0; i < nets.length() && i < 40; i++) {
                JSONObject n = nets.getJSONObject(i);
                list.put(new JSONObject().put("mapValue", new JSONObject().put("fields", new JSONObject()
                        .put("ssid", Firebase.string(n.optString("ssid")))
                        .put("security", Firebase.string(n.optString("security", n.optBoolean("secure") ? "wpa2" : "open")))
                        .put("signal", new JSONObject().put("integerValue", String.valueOf(n.optInt("signal", n.optInt("level"))))))));
            }
            ok = list.length() > 0;
            if (ok) {
                JSONObject write = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", doc.getString("name"))
                                .put("fields", new JSONObject()
                                        .put("state", Firebase.string("done"))
                                        .put("reseaux", new JSONObject().put("arrayValue", new JSONObject().put("values", list)))))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("state").put("reseaux")))
                        .put("updateTransforms", new JSONArray().put(new JSONObject()
                                .put("fieldPath", "doneAt").put("setToServerValue", "REQUEST_TIME")));
                firebase.commit(new JSONArray().put(write));
                Journal.log(context, "Ordre wifiScan : " + list.length() + " réseaux");
                return;
            }
            result = "Aucun réseau wifi trouvé autour de la tablette.";
        } else if ("restart".equals(type)) {
            result = "La tablette redémarre.";
            reboot = true;
        } else if ("status".equals(type)) {
            result = statusText();
            uploadJournal(prefs.getString("fid", null), true);
        } else {
            ok = false;
            result = "Ordre inconnu.";
        }
        // Résultat, et le mot de passe du wifi effacé dans la même écriture.
        JSONObject write = new JSONObject()
                .put("update", new JSONObject()
                        .put("name", doc.getString("name"))
                        .put("fields", new JSONObject()
                                .put("state", Firebase.string(ok ? "done" : "failed"))
                                .put("result", Firebase.string(result))))
                .put("updateMask", new JSONObject().put("fieldPaths",
                        new JSONArray().put("state").put("result").put("password")))
                .put("updateTransforms", new JSONArray().put(new JSONObject()
                        .put("fieldPath", "doneAt").put("setToServerValue", "REQUEST_TIME")));
        firebase.commit(new JSONArray().put(write));
        Journal.log(context, "Ordre " + type + " : " + result);
        if (reboot) {
            handler.postDelayed(() -> {
                try {
                    android.app.admin.DevicePolicyManager dpm = (android.app.admin.DevicePolicyManager)
                            context.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    dpm.reboot(new android.content.ComponentName(context, AdminReceiver.class));
                } catch (Exception e) {
                    Log.w(TAG, "Redémarrage", e);
                }
            }, 3000);
        }
    }

    /** État de la tablette en une phrase, pour l'appli famille. */
    private String statusText() {
        StringBuilder sb = new StringBuilder();
        try {
            JSONObject w = new JSONObject(wifi().status());
            sb.append(w.optString("wifi").isEmpty() ? "Pas de wifi" : "Wifi « " + w.optString("wifi") + " »");
            sb.append(w.optBoolean("internet") ? ", internet OK" : ", pas d'internet");
            if (w.optBoolean("sim")) sb.append(", carte SIM présente");
            android.os.BatteryManager bm =
                    (android.os.BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            sb.append(". Batterie ").append(bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY))
                    .append(" %").append(bm.isCharging() ? " (en charge)" : "");
            sb.append(". Version ").append(appVersion()).append('.');
        } catch (Exception e) {
            sb.append("État indisponible.");
        }
        return sb.toString();
    }

    /** Carte SIM (page « Forfaits SIM ») : sim = {iccid, operateur, reseau, signal, dataMoisMo, vuLe}, ou null. */
    private void reportSim(String fid) {
        try {
            JSONObject info = SimInfo.read(context);
            JSONObject value;
            if (info == null) {
                value = new JSONObject().put("nullValue", JSONObject.NULL);
            } else {
                JSONObject fields = new JSONObject()
                        .put("iccid", Firebase.string(info.optString("iccid")))
                        .put("operateur", Firebase.string(info.optString("operateur")))
                        .put("reseau", Firebase.string(info.optString("reseau")))
                        .put("signal", new JSONObject().put("integerValue", String.valueOf(info.optInt("signal", -1))))
                        .put("dataMoisMo", new JSONObject().put("integerValue", String.valueOf(info.optLong("dataMoisMo", -1))))
                        // Heure de la tablette (réglée automatiquement) : un horodatage serveur ne peut pas
                        // viser un champ à l'intérieur de « sim » écrit dans la même requête.
                        .put("vuLe", new JSONObject().put("timestampValue", isoNow()));
                value = new JSONObject().put("mapValue", new JSONObject().put("fields", fields));
            }
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            .put("fields", new JSONObject().put("sim", value)))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("sim")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
        } catch (Exception e) {
            Log.w(TAG, "Carte SIM", e);
        }
    }

    private static String isoNow() {
        java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return iso.format(new java.util.Date());
    }

    private long lastJournalUpload;
    private String lastJournalSent;

    /** Journal envoyé au plus une fois par heure (ou tout de suite pour l'ordre « état »). */
    private void uploadJournal(String fid, boolean now) {
        long t = System.currentTimeMillis();
        if (fid == null || (!now && t - lastJournalUpload < 3600_000)) return;
        String lines = Journal.tail(context, 200);
        if (!now && lines.equals(lastJournalSent)) return;
        try {
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/logs/" + firebase.uid()))
                            .put("fields", new JSONObject()
                                    .put("lines", Firebase.string(lines))
                                    .put("version", Firebase.string(appVersion()))))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", "updatedAt").put("setToServerValue", "REQUEST_TIME")));
            firebase.commit(new JSONArray().put(write));
            lastJournalUpload = t;
            lastJournalSent = lines;
        } catch (Exception e) {
            Log.w(TAG, "Envoi du journal", e);
        }
    }

    /**
     * Options de la tablette réglées par la famille (families/{fid}.options) :
     * lecture (bouton « Écouter »),
     * radio { active, nom, url }, sos (bouton « SOS famille »). Absentes : tout est désactivé.
     * Sauf lecture, meteo et rappelsAccueil (voix haute, météo et prochain rappel de l'accueil) : actifs sauf si false.
     */
    private JSONObject options = new JSONObject();

    private void readOptions(JSONObject ff) {
        JSONObject out = new JSONObject();
        try {
            JSONObject v = ff.optJSONObject("options");
            JSONObject f = v == null || v.optJSONObject("mapValue") == null ? null
                    : v.optJSONObject("mapValue").optJSONObject("fields");
            if (f != null) {
                // Lecture à voix haute : activée sauf si la famille l'a enlevée (choix de Tanguy).
                out.put("lecture", !f.has("lecture") || bool(f, "lecture"));
                out.put("sos", bool(f, "sos"));
                out.put("meteo", !f.has("meteo") || bool(f, "meteo"));
                out.put("rappelsAccueil", !f.has("rappelsAccueil") || bool(f, "rappelsAccueil"));
                JSONObject r = f.optJSONObject("radio");
                JSONObject rf = r == null || r.optJSONObject("mapValue") == null ? null
                        : r.optJSONObject("mapValue").optJSONObject("fields");
                if (rf != null && bool(rf, "active") && Firebase.str(rf, "url") != null) {
                    // radio.volume : 0-100, par rapport au volume de la tablette (absent : 40, plus doux).
                    JSONObject vol = rf.optJSONObject("volume");
                    int volume = 40;
                    if (vol != null) {
                        if (vol.has("integerValue")) volume = vol.optInt("integerValue", 40);
                        else if (vol.has("doubleValue")) volume = (int) Math.round(vol.optDouble("doubleValue", 40));
                    }
                    out.put("radio", new JSONObject().put("nom", nz(Firebase.str(rf, "nom")))
                            .put("url", Firebase.str(rf, "url"))
                            .put("volume", Math.max(5, Math.min(100, volume))));
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Options", e);
        }
        if (out.toString().equals(options.toString())) return;
        options = out;
        lastPostsJson = null;
        publishPosts();
    }

    private static boolean bool(JSONObject fields, String key) {
        JSONObject v = fields.optJSONObject(key);
        return v != null && v.optBoolean("booleanValue", false);
    }

    /** Volume réglé par la famille (families/{fid}.volume, 0-100) ; absent = volume actuel. */
    private void readVolume(JSONObject ff) {
        // Jamais sous 10 % : la tablette doit toujours s'entendre.
        int volume = ff.has("volume") ? (int) Math.max(10, Math.min(100, Firebase.integer(ff, "volume"))) : -1;
        if (volume == prefs.getInt("volume", -1)) return;
        prefs.edit().putInt("volume", volume).apply();
        listener.onVolume(volume);
    }

    /**
     * Installation par le téléphone du proche (parcours du 21/10) : la tablette quitte « On prépare
     * votre tablette… » à la première photo, ou quand le proche a touché « C'est parfait »
     * (installation.etape == 'fini'), même sans photo. Volume de la sonnerie choisi au test du son.
     */
    private void readInstallation(JSONObject ff) {
        if (prefs.getBoolean("installEnCours", false)) {
            JSONObject in = ff.optJSONObject("installation");
            JSONObject inf = in == null || in.optJSONObject("mapValue") == null ? null
                    : in.optJSONObject("mapValue").optJSONObject("fields");
            if (inf != null && "fini".equals(Firebase.str(inf, "etape"))) finInstallation();
            else relireReprise();
        }
        int sonnerie = ff.has("volumeSonnerie") ? (int) Math.max(10, Math.min(100, Firebase.integer(ff, "volumeSonnerie"))) : 100;
        if (sonnerie != prefs.getInt("volumeSonnerie", 100)) {
            prefs.edit().putInt("volumeSonnerie", sonnerie).apply();
            listener.onVolume(prefs.getInt("volume", -1));
        }
    }

    /** Pendant que le proche finit sur son téléphone : le même écran du code, sans « Recommencer ». */
    private JSONObject installScreen() throws JSONException {
        String code = prefs.getString("pairing", null);
        JSONObject s = new JSONObject().put("step", "pair").put("name", "Tablette")
                .put("claimedName", prefs.getString("installPar", "")).put("joined", true)
                .put("reprendre", reprisePossible());
        if (code != null) s.put("code", code);
        return s;
    }

    /**
     * Installation pas finie 30 min après le scan : un autre proche peut la reprendre en scannant le
     * même code, sans rien effacer (règle du serveur, 21/10). L'écran le dit sous le code.
     */
    private static final long REPRISE_MS = 30 * 60_000;

    private boolean reprisePossible() {
        long depuis = prefs.getLong("installDepuis", 0);
        return depuis > 0 && System.currentTimeMillis() - depuis > REPRISE_MS;
    }

    /** Un autre proche a peut-être repris l'installation : l'écran montre son prénom à lui. */
    private void relireReprise() {
        String code = prefs.getString("pairing", null);
        if (code == null) return;
        try {
            JSONObject doc = firebase.get("pairings/" + code);
            JSONObject f = doc == null ? null : doc.optJSONObject("fields");
            if (f == null) return;
            String par = nz(Firebase.str(f, "claimedName"));
            long depuis = Firebase.timestamp(f, "reservedAt");
            SharedPreferences.Editor e = prefs.edit();
            if (!par.isEmpty()) e.putString("installPar", par);
            if (depuis > 0) e.putLong("installDepuis", depuis);
            e.apply();
        } catch (Exception e) {
            Log.w(TAG, "Reprise de l'installation", e);
        }
    }

    private void finInstallation() {
        // Le code reste connu du compte des appels (pairingFait) : s'il n'a pas encore rejoint la famille
        // (il attendait un ancien code), il peut encore le faire avec celui-ci (règles : 1 h après expiration).
        String code = prefs.getString("pairing", null);
        SharedPreferences.Editor e = prefs.edit().remove("installEnCours").remove("installPar").remove("installDepuis")
                .remove("pairing").remove("pairingExpires");
        if (code != null) e.putString("pairingFait", code);
        e.apply();
        Journal.log(context, "Installation terminée");
        lastStatusJson = null; // l'écran passe tout de suite à l'accueil
    }

    /** Heures de veille réglées par la famille ({active, de, a}) ; absent = 23h-7h. */
    private void readVeille(JSONObject ff) {
        JSONObject v = ff.optJSONObject("veille");
        JSONObject vf = v == null || v.optJSONObject("mapValue") == null ? null
                : v.optJSONObject("mapValue").optJSONObject("fields");
        boolean before = Veille.active(context);
        int beforeFrom = Veille.from(context), beforeTo = Veille.to(context);
        if (vf == null) {
            Veille.save(context, null, 0, 0);
        } else {
            JSONObject act = vf.optJSONObject("active");
            boolean active = act == null || act.optBoolean("booleanValue", true);
            int from = vf.has("de") ? (int) Firebase.integer(vf, "de") : Veille.DEFAULT_FROM;
            int to = vf.has("a") ? (int) Firebase.integer(vf, "a") : Veille.DEFAULT_TO;
            Veille.save(context, active, from, to);
        }
        if (before != Veille.active(context) || beforeFrom != Veille.from(context) || beforeTo != Veille.to(context)) {
            lastPostsJson = null; // la page doit l'apprendre tout de suite
            publishPosts();
        }
    }

    /** Abonnement suspendu, résilié ou absent côté serveur : Papote est en pause. */
    boolean paused() {
        return "suspendu".equals(subscription) || "resilie".equals(subscription) || "aucun".equals(subscription);
    }

    // ---------- Écran Bienvenue : nom, wifi, puis appairage avec la famille ----------

    private static final long PAIRING_MS = 15 * 60_000;
    private static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    boolean pairingActive() {
        return prefs.getString("fid", null) == null && prefs.getString("code", null) == null;
    }

    void setTabletName(String name) {
        handler.post(() -> {
            prefs.edit().putString("tabletName", name.trim()).apply();
            poke();
        });
    }

    void wifiDone() {
        handler.post(() -> {
            prefs.edit().putBoolean("wifiDone", true).apply();
            poke();
        });
    }

    // ---------- Ville de la météo ----------

    /** Communes trouvées pour ce nom (écran Bienvenue) : [{nom, detail, lat, lon}]. */
    String searchMeteo(String query) {
        return Meteo.search(http, query).toString();
    }

    /** Ville choisie sur la tablette ; null = étape passée (pas de météo tant que la famille n'en choisit pas). */
    void setMeteo(String name, double lat, double lon) {
        handler.post(() -> {
            if (name == null) Meteo.skip(context);
            else if (Meteo.save(context, name, lat, lon)) {
                lastWeather = 0;
                refreshWeather();
                String fid = prefs.getString("fid", null);
                if (fid != null) reportMeteo(fid);
            }
            poke();
        });
    }

    /** Ville donnée par le script d'installation (-Ville) : la première commune trouvée, dès qu'internet est là. */
    private void resolvePendingCity() {
        String name = prefs.getString("meteoAChercher", null);
        if (name == null) return;
        JSONArray found = Meteo.search(http, name);
        JSONObject first = found.optJSONObject(0);
        if (first == null) return; // pas d'internet ou nom inconnu : on réessaiera
        prefs.edit().remove("meteoAChercher").apply();
        Meteo.save(context, first.optString("nom"), first.optDouble("lat"), first.optDouble("lon"));
        lastWeather = 0;
    }

    /**
     * Ville en cours écrite sur la fiche de la tablette (members/{uid}.meteoVille), pour que l'appli
     * famille l'affiche. Écrit à part : refusé sans gravité si les règles ne l'acceptent pas encore.
     */
    private void reportMeteo(String fid) {
        if (!Meteo.hasCity(context)) return;
        try {
            JSONObject ville = new JSONObject().put("mapValue", new JSONObject().put("fields", new JSONObject()
                    .put("nom", Firebase.string(Meteo.name(context)))
                    .put("lat", new JSONObject().put("doubleValue", Meteo.lat(context)))
                    .put("lon", new JSONObject().put("doubleValue", Meteo.lon(context)))));
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            .put("fields", new JSONObject().put("meteoVille", ville)))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("meteoVille")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
        } catch (Exception e) {
            Log.w(TAG, "Ville de la météo sur la fiche", e);
        }
    }

    /**
     * Code de jumelage gardé pour toujours (pairingFait) : le compte des appels s'en sert pour entrer
     * dans la famille, même longtemps après (règles du 26/10). Perdu (installation interrompue, comme
     * T-003 le 26/10 : plus d'appels) : on le relit sur la fiche de la tablette, une fois par démarrage.
     */
    private boolean jumelageVerifie;
    private void recupererJumelage(String fid) {
        if (jumelageVerifie || pairingCode() != null) return;
        jumelageVerifie = true;
        try {
            JSONObject doc = firebase.get("families/" + fid + "/members/" + firebase.uid(), "pairing");
            JSONObject f = doc == null ? null : doc.optJSONObject("fields");
            String code = f == null ? null : Firebase.str(f, "pairing");
            if (code != null && !code.isEmpty()) {
                prefs.edit().putString("pairingFait", code).apply();
                Journal.log(context, "Code de jumelage retrouvé pour le compte des appels");
            }
        } catch (Exception e) {
            jumelageVerifie = false;
            Log.w(TAG, "Code de jumelage", e);
        }
    }

    String pairingCode() {
        String code = prefs.getString("pairing", null);
        return code != null ? code : prefs.getString("pairingFait", null);
    }

    private void welcome(JSONObject s) {
        try {
            s.put("state", "welcome");
            String json = s.toString();
            if (json.equals(lastStatusJson)) return;
            lastStatusJson = json;
            listener.onStatus(s);
        } catch (JSONException ignored) { }
    }

    /** N° de série Android (le même que « adb shell getprop ro.serialno »), ou null s'il est illisible. */
    @SuppressWarnings({"deprecation", "MissingPermission"})
    static String serialNumber() {
        String s = null;
        try {
            s = android.os.Build.getSerial(); // permis à l'appli propriétaire de l'appareil
        } catch (Exception e) {
            Log.w(TAG, "N° de série", e);
        }
        if (s == null || s.isEmpty() || android.os.Build.UNKNOWN.equals(s)) s = android.os.Build.SERIAL;
        return s == null || s.isEmpty() || android.os.Build.UNKNOWN.equals(s) ? null : s;
    }

    /**
     * Écrans de la tablette avant la famille (parcours du 21/10) : Bienvenue, Internet (sauté avec une
     * carte SIM), puis le code à scanner. Le nom et la météo se règlent sur le téléphone du proche.
     *   waiting    code affiché (QR + code), renouvelé toutes les 15 min tant que personne ne l'a pris
     *   reserved   « On prépare votre tablette… », « Julie s'en occupe », « Recommencer » (pas d'expiration)
     *   confirmed  la famille est créée : la tablette y entre sans rien demander
     *   claimed    ancien parcours (tablette de remplacement) : « C'est bien vous ? »
     */
    private void pairingStep() throws IOException, JSONException {
        boolean ancienne = prefs.getString("tabletName", null) != null; // installation commencée avant le 21/10
        if (!ancienne && !prefs.getBoolean("bienvenueVue", false)) { welcome(new JSONObject().put("step", "start")); return; }
        if (!prefs.getBoolean("wifiDone", false)) { welcome(new JSONObject().put("step", "wifi")); return; }
        String name = prefs.getString("tabletName", "Tablette");
        firebase.token();
        firebase.ensureCallsAccount();
        String code = prefs.getString("pairing", null);
        JSONObject f = null;
        if (code != null) {
            JSONObject doc = firebase.get("pairings/" + code);
            f = doc == null ? null : doc.optJSONObject("fields");
        }
        String state = f == null ? "gone" : Firebase.str(f, "status");
        // Un code que personne n'a pris expire ; un code réservé, jamais.
        if ("waiting".equals(state) && System.currentTimeMillis() > prefs.getLong("pairingExpires", 0)) state = "gone";
        if ("waiting".equals(state)) {
            welcome(new JSONObject().put("step", "pair").put("name", name).put("code", code)
                    .put("expires", prefs.getLong("pairingExpires", 0)));
        } else if ("reserved".equals(state)) {
            long reservedAt = Firebase.timestamp(f, "reservedAt");
            if (reservedAt > 0) prefs.edit().putLong("installDepuis", reservedAt).apply();
            welcome(new JSONObject().put("step", "pair").put("name", name).put("code", code)
                    .put("claimedName", nz(Firebase.str(f, "claimedName"))).put("restart", true)
                    .put("reprendre", reprisePossible()));
        } else if ("confirmed".equals(state) && Firebase.str(f, "fid") != null) {
            String famille = nz(Firebase.str(f, "familyName"));
            if (joinFamily(code, Firebase.str(f, "fid"), famille.isEmpty() ? name : famille)) {
                long reservedAt = Firebase.timestamp(f, "reservedAt");
                prefs.edit().putBoolean("installEnCours", true)
                        .putString("installPar", nz(Firebase.str(f, "claimedName")))
                        .putLong("installDepuis", reservedAt > 0 ? reservedAt : System.currentTimeMillis()).apply();
                Journal.log(context, "Tablette reliée à « " + famille + " »");
                welcome(installScreen());
                poke();
            }
        } else if ("claimed".equals(state)) {
            welcome(new JSONObject().put("step", "confirm").put("name", name).put("code", code)
                    .put("claimedName", nz(Firebase.str(f, "claimedName")))
                    .put("familyName", nz(Firebase.str(f, "familyName"))));
        } else {
            // Annulé, refusé, expiré ou disparu : un nouveau code tout de suite.
            prefs.edit().remove("pairing").remove("pairingExpires").apply();
            code = newPairing(name);
            if (code == null) {
                welcome(new JSONObject().put("step", "pair").put("name", name)
                        .put("error", "Impossible de créer le code. Vérifiez la connexion internet."));
            } else {
                welcome(new JSONObject().put("step", "pair").put("name", name).put("code", code)
                        .put("expires", prefs.getLong("pairingExpires", 0)));
            }
        }
    }

    /**
     * « Retour » sur les écrans d'installation : du code au wifi, du wifi à Bienvenue (demande de Tanguy :
     * pouvoir revenir en arrière sans stress). Pas pendant qu'un proche installe (code réservé).
     */
    void welcomeBack(boolean toStart) {
        handler.post(() -> {
            // toStart : wifi sauté (carte SIM), le code revient directement à Bienvenue.
            if (toStart) prefs.edit().remove("wifiDone").remove("bienvenueVue").apply();
            else if (prefs.getBoolean("wifiDone", false)) prefs.edit().remove("wifiDone").apply();
            else prefs.edit().remove("bienvenueVue").apply();
            poke();
        });
    }

    /** « Commencer » sur l'écran Bienvenue. */
    void welcomeSeen() {
        handler.post(() -> {
            prefs.edit().putBoolean("bienvenueVue", true).apply();
            poke();
        });
    }

    /** « Recommencer avec un autre téléphone » : la réservation est annulée, un nouveau code s'affiche. */
    void cancelPairing() {
        handler.post(() -> {
            String code = prefs.getString("pairing", null);
            if (code == null) return;
            try {
                JSONObject update = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("pairings/" + code))
                                .put("fields", new JSONObject().put("status", Firebase.string("cancelled"))))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("status")));
                firebase.commit(new JSONArray().put(update));
                Journal.log(context, "Installation recommencée avec un autre téléphone");
            } catch (Exception e) {
                Log.w(TAG, "Annulation de la réservation", e);
            }
            prefs.edit().remove("pairing").remove("pairingExpires").apply();
            poke();
        });
    }

    private String newPairing(String name) {
        java.security.SecureRandom rnd = new java.security.SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8; i++) sb.append(CODE_ALPHABET.charAt(rnd.nextInt(CODE_ALPHABET.length())));
        String code = sb.toString();
        long expires = System.currentTimeMillis() + PAIRING_MS;
        try {
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
            iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            JSONObject fields = new JSONObject()
                    .put("tabletUid", Firebase.string(firebase.uid()))
                    .put("name", Firebase.string(name))
                    .put("status", Firebase.string("waiting"))
                    .put("expiresAt", new JSONObject().put("timestampValue", iso.format(new java.util.Date(expires))));
            if (firebase.callsUid() != null) fields.put("callsUid", Firebase.string(firebase.callsUid()));
            // N° de série : le serveur reconnaît la tablette préparée et relie sa commande à la famille.
            String serie = serialNumber();
            if (serie != null) fields.put("serie", Firebase.string(serie));
            JSONObject write = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("pairings/" + code))
                            .put("fields", fields))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", "createdAt").put("setToServerValue", "REQUEST_TIME")))
                    .put("currentDocument", new JSONObject().put("exists", false));
            firebase.commit(new JSONArray().put(write));
            prefs.edit().putString("pairing", code).putLong("pairingExpires", expires).apply();
            return code;
        } catch (Exception e) {
            Log.w(TAG, "Code d'appairage", e);
            return null;
        }
    }

    /** La tablette entre dans la famille (sa fiche membre, avec le code de jumelage comme preuve). */
    private boolean joinFamily(String code, String fid, String memberName) {
        try {
            JSONObject fields = new JSONObject()
                    .put("name", Firebase.string(memberName))
                    .put("role", Firebase.string("tablette"))
                    .put("pairing", Firebase.string(code))
                    .put("canCall", new JSONObject().put("booleanValue", true));
            JSONObject member = new JSONObject()
                    .put("update", new JSONObject()
                            .put("name", Firebase.docName("families/" + fid + "/members/" + firebase.uid()))
                            .put("fields", fields))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", "joinedAt").put("setToServerValue", "REQUEST_TIME")))
                    .put("currentDocument", new JSONObject().put("exists", false));
            firebase.commit(new JSONArray().put(member));
            prefs.edit().putString("fid", fid).apply();
            return true;
        } catch (Firebase.ApiException e) {
            // Fiche déjà écrite (réponse perdue la fois d'avant) : la tablette est bien dans la famille.
            if (e.code == 409) {
                prefs.edit().putString("fid", fid).apply();
                return true;
            }
            Log.w(TAG, "Entrée dans la famille", e);
            return false;
        } catch (Exception e) {
            Log.w(TAG, "Entrée dans la famille", e);
            return false;
        }
    }

    /** Réponse sur la tablette : « C'est bien vous ? » Oui / Non. */
    void confirmPairing(boolean yes) {
        handler.post(() -> {
            String code = prefs.getString("pairing", null);
            if (code == null) return;
            try {
                JSONObject doc = firebase.get("pairings/" + code);
                JSONObject f = doc == null ? null : doc.optJSONObject("fields");
                if (f == null || !"claimed".equals(Firebase.str(f, "status"))) return;
                String fid = Firebase.str(f, "fid");
                JSONObject update = new JSONObject()
                        .put("update", new JSONObject()
                                .put("name", Firebase.docName("pairings/" + code))
                                .put("fields", new JSONObject().put("status", Firebase.string(yes ? "confirmed" : "refused"))))
                        .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray().put("status")));
                firebase.commit(new JSONArray().put(update));
                if (!yes || fid == null) {
                    prefs.edit().remove("pairing").remove("pairingExpires").apply();
                    poke();
                    return;
                }
                if (joinFamily(code, fid, prefs.getString("tabletName", "Tablette"))) {
                    status("ok", null);
                    poke();
                }
            } catch (Exception e) {
                Log.w(TAG, "Confirmation de l'appairage", e);
            }
        });
    }

    private String lastState = "";

    private void status(String state, String message) {
        if ("ok".equals(state) && prefs.getBoolean("installEnCours", false)) {
            // Famille rejointe, mais le proche finit les réglages : on garde « On prépare… ».
            try {
                welcome(installScreen());
            } catch (JSONException ignored) { }
            return;
        }
        if (!state.equals(lastState)) {
            Journal.log(context, "Synchronisation : " + state + (message == null ? "" : " (" + message + ")"));
            lastState = state;
        }
        try {
            JSONObject s = new JSONObject().put("state", state);
            if (message != null) s.put("message", message);
            String json = s.toString();
            if (json.equals(lastStatusJson)) return;
            lastStatusJson = json;
            listener.onStatus(s);
        } catch (JSONException ignored) { }
    }
}
