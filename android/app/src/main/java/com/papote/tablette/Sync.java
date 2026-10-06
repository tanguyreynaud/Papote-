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
        String createdAtRaw;
        long createdAt;
        long seenAt;
        long hearts;
        String imagePath;
        String audioPath;
        long duration;
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
    private long lastFullRefresh;
    private long lastRev = Long.MIN_VALUE; // marqueur de changement de la famille
    private volatile boolean realtime;
    private boolean loadedOnce;
    private long lastReminders;
    private String lastRemindersJson;
    private long lastWeather;
    private String lastPostsJson;
    private String lastStatusJson;

    Sync(Context context, SharedPreferences prefs, Listener listener) {
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

    /** Le code famille a changé : on oublie la famille actuelle. */
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
        String code = prefs.getString("code", null);
        if (code == null) {
            status("setup", "Relancez le script d'installation avec le code famille.");
            return null;
        }
        JSONObject invite = firebase.get("invites/" + code);
        if (invite == null) {
            status("setup", "Le code famille « " + code + " » est inconnu.");
            return null;
        }
        fid = Firebase.str(invite.getJSONObject("fields"), "fid");
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
                    .put("code", Firebase.string(code));
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
            JSONObject family = firebase.get("families/" + fid, "name", "rev");
            long rev = 0;
            JSONObject ff = family == null ? null : family.optJSONObject("fields");
            if (ff != null) {
                familyName = Firebase.str(ff, "name");
                rev = Firebase.integer(ff, "rev");
            }
            if (rev == lastRev && now - lastFullRefresh < FULL_REFRESH_MS) {
                status("ok", null);
                heartbeat(fid, "lastOnline");
                return;
            }
            lastRev = rev;
            lastReminders = 0; // les rappels ont peut-être changé aussi
            result = firebase.runQuery("families/" + fid, postsQuery(true));
        } catch (Firebase.ApiException e) {
            if (e.code == 403 || e.code == 404) {
                // Plus membre (famille supprimée ou tablette retirée) : on rejoindra avec le code.
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
        publishPosts();
        heartbeat(fid, "lastOnline");
        if (newArrival) listener.onNewArrival();
    }

    private JSONObject postsQuery(boolean full) throws JSONException {
        JSONArray fields = new JSONArray();
        for (String f : new String[]{"type", "text", "authorName", "createdAt", "seenAt", "hearts", "duration"}) {
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
        JSONObject created = f.optJSONObject("createdAt");
        p.createdAtRaw = created == null ? null : created.optString("timestampValue", null);
        p.createdAt = Firebase.parseTimestamp(p.createdAtRaw);
        p.seenAt = Firebase.timestamp(f, "seenAt");
        p.hearts = Firebase.integer(f, "hearts");
        p.duration = Firebase.integer(f, "duration");
        return p;
    }

    /** Télécharge les photos et les messages vocaux en fichiers locaux. */
    private void downloadMedia(String fid) {
        for (Post p : posts.values()) {
            boolean photo = "photo".equals(p.type) && p.imagePath == null;
            boolean voice = "voice".equals(p.type) && p.audioPath == null;
            if (!photo && !voice) continue;
            String field = photo ? "image" : "audio";
            File file = existing(p.id);
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
                            .put("fields", new JSONObject()))
                    .put("updateMask", new JSONObject().put("fieldPaths", new JSONArray()))
                    .put("updateTransforms", new JSONArray().put(new JSONObject()
                            .put("fieldPath", field).put("setToServerValue", "REQUEST_TIME")))
                    .put("currentDocument", new JSONObject().put("exists", true));
            firebase.commit(new JSONArray().put(write));
            lastHeartbeat.put(field, now);
        } catch (Exception e) {
            Log.w(TAG, "Veille " + field, e);
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
                        .put("createdAt", p.createdAt)
                        .put("seen", p.seenAt > 0)
                        .put("hearts", p.hearts)
                        .put("image", p.imagePath == null ? JSONObject.NULL : p.imagePath)
                        .put("audio", p.audioPath == null ? JSONObject.NULL : p.audioPath)
                        .put("duration", p.duration));
            }
            JSONObject payload = new JSONObject().put("familyName", familyName == null ? "" : familyName)
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
