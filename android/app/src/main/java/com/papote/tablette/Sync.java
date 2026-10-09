package com.papote.tablette;

import android.content.Context;
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
    }

    private static final String TAG = "PapoteSync";
    private static final long POLL_MS = 20_000;               // nouveaux envois
    private static final long FULL_REFRESH_MS = 6 * 3600_000; // relecture complète de sécurité
    private static final long REALTIME_POLL_MS = 10 * 60_000; // quand la page reçoit les changements en direct
    private static final long WEATHER_MS = 30 * 60_000;
    private static final long REMINDERS_MS = 6 * 3600_000;
    private static final int MAX_POSTS = 60;
    private static final double LAT = 44.9372;                // Saint-Martin-de-Valamas
    private static final double LON = 4.3687;

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

    Sync(Context context, SharedPreferences prefs, Listener listener) {
        this.context = context.getApplicationContext();
        this.prefs = prefs;
        this.firebase = new Firebase(context, prefs);
        this.http = new Http(context);
        this.imageDir = new File(context.getFilesDir(), "photos");
        this.listener = listener;
        imageDir.mkdirs();
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    void start() {
        handler.removeCallbacks(loop);
        handler.post(loop);
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
                refreshWeather();
                syncPosts();
                syncReminders();
                syncFamilyExtras();
            } catch (Exception e) {
                Log.w(TAG, "Synchronisation", e);
            }
            // Pendant l'appairage, on regarde souvent si quelqu'un a tapé le code.
            handler.postDelayed(this, pairingActive() ? 4_000 : realtime ? REALTIME_POLL_MS : POLL_MS);
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
            JSONObject family = firebase.get("families/" + fid, "name", "rev", "code", "textSize", "abonnement");
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
                prefs.edit().remove("fid").apply();
            }
            status("offline", null);
            return;
        } catch (IOException e) {
            status("offline", null);
            return;
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
        downloadMedia(fid);
        downloadVideos(fid);
        publishPosts();
        heartbeat(fid, "lastOnline");
        if (newArrival && !paused()) listener.onNewArrival();
    }

    private JSONObject postsQuery(boolean full) throws JSONException {
        JSONArray fields = new JSONArray();
        for (String f : new String[]{"type", "text", "authorName", "authorUid", "createdAt", "seenAt", "hearts", "duration", "chunks", "mime", "imageUrl", "videoUrl", "photos"}) {
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
        return p;
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
    private File downloadToFile(String url, String id, String ext) throws Exception {
        javax.net.ssl.HttpsURLConnection c =
                (javax.net.ssl.HttpsURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        File tmp = new File(imageDir, id + ".tmp");
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            java.io.InputStream in = c.getInputStream();
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
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
        if (fid == null || (last != null && now - last < HEARTBEAT_MS)) return;
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
            boolean charging = bm.isCharging();
            android.content.Intent sticky = context.registerReceiver(null,
                    new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (sticky != null) charging = charging || sticky.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0;
            JSONObject battery = new JSONObject().put("mapValue", new JSONObject().put("fields", new JSONObject()
                    .put("level", new JSONObject().put("integerValue", String.valueOf(Math.max(0, Math.min(100, level)))))
                    .put("charging", new JSONObject().put("booleanValue", charging))));
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
            prefs.edit().remove("fid").remove("code").remove("pairing").remove("pairingExpires")
                    .remove("tabletName").remove("wifiDone").apply();
            firebase.forgetAll();
            posts.clear();
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
                        .put("duration", p.duration));
            }
            JSONObject payload = new JSONObject().put("familyName", familyName == null ? "" : familyName)
                    .put("familyCode", familyCode == null ? "" : familyCode)
                    .put("textSize", textSize == null ? "" : textSize)
                    .put("subscription", subscription)
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
                        .put("lastAck", nz(Firebase.str(f, "lastAck"))));
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
            try {
                JSONArray members = firebase.list("families/" + fid + "/members");
                for (int i = 0; i < members.length(); i++) {
                    JSONObject doc = members.getJSONObject(i);
                    JSONObject f = doc.optJSONObject("fields");
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
            JSONObject payload = new JSONObject().put("faces", faces).put("birthdays", birthdays);
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

    // ---------- Météo ----------

    private void refreshWeather() {
        long now = System.currentTimeMillis();
        if (now - lastWeather < WEATHER_MS) return;
        try {
            String url = "https://api.open-meteo.com/v1/forecast?latitude=" + LAT + "&longitude=" + LON
                    + "&current=temperature_2m,weather_code,is_day"
                    + "&daily=weather_code,temperature_2m_max,temperature_2m_min"
                    + "&timezone=Europe%2FParis&forecast_days=2";
            Http.Response r = http.request("GET", url, null, null, null);
            if (!r.ok()) return;
            lastWeather = now;
            listener.onWeather(new JSONObject(r.body));
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

    String pairingCode() {
        return prefs.getString("pairing", null);
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

    private void pairingStep() throws IOException, JSONException {
        String name = prefs.getString("tabletName", null);
        if (name == null || name.isEmpty()) { welcome(new JSONObject().put("step", "name")); return; }
        if (!prefs.getBoolean("wifiDone", false)) { welcome(new JSONObject().put("step", "wifi").put("name", name)); return; }
        firebase.token();
        firebase.ensureCallsAccount();
        String code = prefs.getString("pairing", null);
        long expires = prefs.getLong("pairingExpires", 0);
        if (code == null || System.currentTimeMillis() > expires) {
            code = newPairing(name);
            if (code == null) {
                welcome(new JSONObject().put("step", "pair").put("name", name)
                        .put("error", "Impossible de créer le code. Vérifiez la connexion internet."));
                return;
            }
        }
        JSONObject doc = firebase.get("pairings/" + code);
        JSONObject f = doc == null ? null : doc.optJSONObject("fields");
        String state = f == null ? "gone" : Firebase.str(f, "status");
        if ("claimed".equals(state)) {
            welcome(new JSONObject().put("step", "confirm").put("name", name).put("code", code)
                    .put("claimedName", nz(Firebase.str(f, "claimedName")))
                    .put("familyName", nz(Firebase.str(f, "familyName"))));
        } else if ("waiting".equals(state)) {
            welcome(new JSONObject().put("step", "pair").put("name", name).put("code", code)
                    .put("expires", prefs.getLong("pairingExpires", 0)));
        } else {
            // Refusé, expiré ou disparu : un nouveau code au prochain tour.
            prefs.edit().remove("pairing").remove("pairingExpires").apply();
        }
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
                JSONObject fields = new JSONObject()
                        .put("name", Firebase.string(prefs.getString("tabletName", "Tablette")))
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
                status("ok", null);
                poke();
            } catch (Exception e) {
                Log.w(TAG, "Confirmation de l'appairage", e);
            }
        });
    }

    private String lastState = "";

    private void status(String state, String message) {
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
