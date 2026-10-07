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
            handler.postDelayed(this, realtime ? REALTIME_POLL_MS : POLL_MS);
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
        if (fid != null) return fid;
        // Code tablette : créé dans l'app famille (Réglages > Installer une tablette).
        String code = prefs.getString("code", null);
        if (code == null) {
            status("setup", "Relancez le script d'installation avec le code tablette.");
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
            JSONObject family = firebase.get("families/" + fid, "name", "rev", "code", "textSize");
            long rev = 0;
            JSONObject ff = family == null ? null : family.optJSONObject("fields");
            if (ff != null) {
                familyName = Firebase.str(ff, "name");
                familyCode = Firebase.str(ff, "code");
                textSize = Firebase.str(ff, "textSize");
                rev = Firebase.integer(ff, "rev");
            }
            if (rev == lastRev && now - lastFullRefresh < FULL_REFRESH_MS) {
                status("ok", null);
                heartbeat(fid, "lastOnline");
                return;
            }
            lastRev = rev;
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
                if (files != null) for (File f : files) if (f.getName().startsWith(id + ".")) f.delete();
            }
        }
        loadedOnce = true;
        downloadMedia(fid);
        downloadVideos(fid);
        publishPosts();
        heartbeat(fid, "lastOnline");
        if (newArrival) listener.onNewArrival();
    }

    private JSONObject postsQuery(boolean full) throws JSONException {
        JSONArray fields = new JSONArray();
        for (String f : new String[]{"type", "text", "authorName", "authorUid", "createdAt", "seenAt", "hearts", "duration", "chunks", "mime", "imageUrl", "videoUrl"}) {
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
        if ("lastOnline".equals(field)) reportBattery(fid);
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
                        .put("audio", p.audioPath == null ? JSONObject.NULL : p.audioPath)
                        .put("video", p.videoPath == null ? JSONObject.NULL : p.videoPath)
                        .put("duration", p.duration));
            }
            JSONObject payload = new JSONObject().put("familyName", familyName == null ? "" : familyName)
                    .put("familyCode", familyCode == null ? "" : familyCode)
                    .put("textSize", textSize == null ? "" : textSize)
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

    private void status(String state, String message) {
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
