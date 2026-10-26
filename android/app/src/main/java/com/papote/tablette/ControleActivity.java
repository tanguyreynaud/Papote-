package com.papote.tablette;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.VideoView;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Contrôle atelier (installer-tablette.ps1, avant la mise en carton) : le matériel est vérifié sans
 * famille ni appairage. Le script lance une étape à la fois :
 *   adb shell am start -n com.papote.tablette/.ControleActivity --es etape son|micro|camera|ecran|fin [--ei volume 70]
 * et lit le résultat dans Android/data/com.papote.tablette/files/controle.txt (« etape=ok|ko|... »).
 * Auto-test sans question (controle-atelier.ps1 -Rapide) : medias (photo, voix et vidéo dans la page,
 * internet jusqu'à Firebase), video (lecteur d'Android, comme les vidéos reçues), voix (voix d'Android),
 * boucle (le micro entend le haut-parleur), puis bilan (« Tout est prêt » ou ce qui ne va pas).
 * Passage des écrans (passage-ecrans.ps1) : galerie --ei n N ouvre le vrai écran de la tablette avec
 * une fausse famille (assets/controle/ecrans.js), internet coupé : rien ne part vers Firebase.
 * Réservée à adb : l'activité demande la permission DUMP (shell l'a, une appli ordinaire non).
 */
public class ControleActivity extends Activity {
    private static final String TAG = "PapoteControle";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private android.hardware.Camera camera;
    private MediaPlayer player;
    private WebView web;
    private VideoView video;
    private android.speech.tts.TextToSpeech tts;
    private volatile boolean stop;
    private int volume = 70;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#FDFAF5"));
        setContentView(root);
        run(getIntent().getStringExtra("etape"));
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        cleanup();
        root.removeAllViews();
        run(intent.getStringExtra("etape"));
    }

    private void run(String etape) {
        if (etape == null) etape = "";
        stop = false;
        volume = Math.max(10, Math.min(100, getIntent().getIntExtra("volume", 70)));
        switch (etape) {
            case "son": son(); break;
            case "micro": micro(); break;
            case "camera": camera(); break;
            case "ecran": ecran(); break;
            case "medias": page(LocalContent.ORIGIN + "/controle/medias.html", false); break;
            case "galerie": page(LocalContent.PAGE + "?controle=" + getIntent().getIntExtra("n", 1), true); break;
            case "video": video(); break;
            case "voix": voix(); break;
            case "boucle": boucle(); break;
            case "bilan": bilan(getIntent().getStringExtra("b64")); break;
            default: finish(); break; // « fin » : retour à Papote
        }
    }

    // ---------- Résultat lu par le script ----------

    private void result(String etape, String value) {
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) return;
            FileWriter w = new FileWriter(new File(dir, "controle.txt"), true);
            w.write(etape + "=" + value + "\n");
            w.close();
        } catch (Exception e) {
            Log.w(TAG, "Résultat " + etape, e);
        }
    }

    private TextView message(String title, String sub) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(44);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextColor(Color.parseColor("#24212F"));
        t.setGravity(Gravity.CENTER);
        box.addView(t);
        TextView s = new TextView(this);
        s.setText(sub);
        s.setTextSize(26);
        s.setTextColor(Color.parseColor("#5B5668"));
        s.setGravity(Gravity.CENTER);
        s.setPadding(40, 24, 40, 0);
        box.addView(s);
        root.addView(box, new FrameLayout.LayoutParams(-1, -1));
        return s;
    }

    private void media(int percent) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * percent / 100, 0);
    }

    // ---------- Haut-parleur (ou casque branché) ----------

    private void son() {
        message("Contrôle du son", "Vous devez entendre « Bonjour, et bienvenue sur Papote ».");
        media(volume);
        try {
            player = new MediaPlayer();
            android.content.res.AssetFileDescriptor fd = getAssets().openFd("bienvenue/voix/accueil.mp3");
            player.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
            fd.close();
            player.setOnCompletionListener(p -> result("son", "joue"));
            player.prepare();
            player.start();
        } catch (Exception e) {
            Log.w(TAG, "Son", e);
            result("son", "erreur " + e.getMessage());
        }
    }

    // ---------- Micro : 4 s enregistrées puis réécoutées, avec le niveau mesuré ----------

    private void micro() {
        final TextView sub = message("Contrôle du micro", "Parlez maintenant, près de la tablette…");
        media(volume);
        new Thread(() -> {
            int rate = 16000;
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            short[] pcm = new short[rate * 4];
            int peak = 0;
            AudioRecord rec = null;
            try {
                rec = new AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 4096));
                rec.startRecording();
                int read = 0;
                while (read < pcm.length && !stop) {
                    int n = rec.read(pcm, read, Math.min(2048, pcm.length - read));
                    if (n <= 0) break;
                    for (int i = read; i < read + n; i++) peak = Math.max(peak, Math.abs((int) pcm[i]));
                    read += n;
                }
            } catch (Exception e) {
                Log.w(TAG, "Micro", e);
                result("micro", "erreur " + e.getMessage());
                return;
            } finally {
                if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
            }
            if (stop) return;
            handler.post(() -> sub.setText("Écoutez : la tablette rejoue ce que vous avez dit."));
            AudioTrack track = new AudioTrack(AudioManager.STREAM_MUSIC, rate, AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, pcm.length * 2, AudioTrack.MODE_STATIC);
            track.write(pcm, 0, pcm.length);
            track.play();
            try { Thread.sleep(4300); } catch (InterruptedException ignored) { }
            track.release();
            // Niveau crête sur 32767 : un micro bouché ou en panne reste sous ~300.
            result("micro", "niveau " + peak);
            handler.post(() -> sub.setText("Terminé."));
        }, "papote-controle-micro").start();
    }

    // ---------- Caméra de face ----------

    @SuppressWarnings("deprecation")
    private void camera() {
        SurfaceView view = new SurfaceView(this);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        TextView label = new TextView(this);
        label.setText("Contrôle de la caméra : vous devez vous voir");
        label.setTextSize(26);
        label.setTextColor(Color.WHITE);
        label.setBackgroundColor(Color.parseColor("#99000000"));
        label.setPadding(30, 16, 30, 16);
        root.addView(label, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL));
        view.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder h) {
                try {
                    int front = -1;
                    android.hardware.Camera.CameraInfo info = new android.hardware.Camera.CameraInfo();
                    for (int i = 0; i < android.hardware.Camera.getNumberOfCameras(); i++) {
                        android.hardware.Camera.getCameraInfo(i, info);
                        if (info.facing == android.hardware.Camera.CameraInfo.CAMERA_FACING_FRONT) { front = i; break; }
                    }
                    camera = android.hardware.Camera.open(front >= 0 ? front : 0);
                    // Image aux bonnes proportions (sinon étirée sur tout l'écran : « je suis écrasé »).
                    android.hardware.Camera.Parameters p = camera.getParameters();
                    // La plus grande taille : tout le champ du capteur (une taille 16/9 le recadre, effet zoom).
                    android.hardware.Camera.Size best = p.getPreviewSize();
                    for (android.hardware.Camera.Size z : p.getSupportedPreviewSizes()) {
                        if ((long) z.width * z.height > (long) best.width * best.height) best = z;
                    }
                    p.setPreviewSize(best.width, best.height);
                    camera.setParameters(p);
                    final float ratio = (float) best.width / best.height;
                    view.post(() -> {
                        int w = root.getWidth(), hh = root.getHeight();
                        int vw = w, vh = Math.round(w / ratio);
                        if (vh > hh) { vh = hh; vw = Math.round(hh * ratio); }
                        view.setLayoutParams(new FrameLayout.LayoutParams(vw, vh, Gravity.CENTER));
                    });
                    camera.setPreviewDisplay(h);
                    // Une vraie image reçue du capteur (une caméra en panne s'ouvre parfois sans rien donner).
                    camera.setOneShotPreviewCallback((data, c) -> result("camera-image", "ok " + data.length));
                    camera.startPreview();
                    result("camera", front >= 0 ? "avant" : "arriere");
                } catch (Exception e) {
                    Log.w(TAG, "Caméra", e);
                    result("camera", "erreur " + e.getMessage());
                }
            }
            @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { }
            @Override public void surfaceDestroyed(SurfaceHolder h) { releaseCamera(); }
        });
    }

    @SuppressWarnings("deprecation")
    private void releaseCamera() {
        if (camera != null) {
            try { camera.stopPreview(); } catch (Exception ignored) { }
            camera.release();
            camera = null;
        }
    }

    // ---------- Écran tactile : 3 x 3 cases à toucher, coins et bords compris ----------

    private void ecran() {
        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(3);
        grid.setRowCount(3);
        final int[] restantes = {9};
        for (int i = 0; i < 9; i++) {
            final TextView cell = new TextView(this);
            cell.setText("Touchez");
            cell.setTextSize(24);
            cell.setGravity(Gravity.CENTER);
            cell.setTextColor(Color.parseColor("#4F46E5"));
            cell.setBackgroundColor(Color.parseColor("#EEF0FF"));
            GridLayout.LayoutParams lp = new GridLayout.LayoutParams(
                    GridLayout.spec(i / 3, 1f), GridLayout.spec(i % 3, 1f));
            lp.width = 0;
            lp.height = 0;
            lp.setMargins(6, 6, 6, 6);
            cell.setOnClickListener(v -> {
                if (v.getTag() != null) return;
                v.setTag(true);
                cell.setText("✓");
                cell.setTextColor(Color.WHITE);
                cell.setBackgroundColor(Color.parseColor("#15803D"));
                if (--restantes[0] == 0) result("ecran", "ok");
            });
            grid.addView(cell, lp);
        }
        root.addView(grid, new FrameLayout.LayoutParams(-1, -1));
    }

    // ---------- Pages dans une WebView sans pont vers l'app : rien ne peut écrire dans la famille ----------

    /** Ce que les pages de contrôle (assets/controle) peuvent faire : noter un résultat, rien d'autre. */
    private final class Pont {
        @JavascriptInterface public void resultat(String etape, String valeur) { result(etape, valeur); }
    }

    private void page(String url, boolean galerie) {
        if (!galerie) media(volume); // passage des écrans : le volume de la tablette ne change pas
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#FDFAF5"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Pont(), "ControleJs");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return intercept(r.getUrl(), galerie);
            }
        });
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i(TAG, m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(url);
    }

    private WebResourceResponse intercept(Uri url, boolean galerie) {
        boolean local = url != null && LocalContent.HOST.equals(url.getHost());
        if (!galerie) return local ? LocalContent.intercept(this, url) : null;
        // Passage des écrans : internet coupé (pas de Firebase), appels.js remplacé par la fausse famille.
        if (!local) return vide("text/plain");
        String path = url.getPath() == null ? "" : url.getPath();
        if (path.equals("/appels.js")) return vide("text/javascript");
        if (!path.equals("/tablette.html")) return LocalContent.intercept(this, url);
        try (InputStream in = getAssets().open("tablette.html")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            String html = out.toString("UTF-8").replaceFirst("<head>", "<head><script src=\"controle/ecrans.js\"></script>");
            return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            Log.w(TAG, "Page de la tablette", e);
            return vide("text/html");
        }
    }

    private static WebResourceResponse vide(String mime) {
        return new WebResourceResponse(mime, "utf-8", new ByteArrayInputStream(new byte[0]));
    }

    // ---------- Vidéo par le lecteur d'Android (celui des vidéos reçues) ----------

    private void video() {
        message("Contrôle de la vidéo", "");
        media(volume);
        File f = new File(getCacheDir(), "video-essai.mp4");
        try (InputStream in = getAssets().open("controle/video-essai.mp4"); FileOutputStream out = new FileOutputStream(f)) {
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
            result("video", "erreur " + e.getMessage());
            return;
        }
        video = new VideoView(this);
        root.addView(video, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        final int[] taille = {0, 0};
        video.setOnPreparedListener(mp -> { taille[0] = mp.getVideoWidth(); taille[1] = mp.getVideoHeight(); });
        video.setOnCompletionListener(mp -> result("video", taille[0] > 0 ? "ok " + taille[0] + "x" + taille[1] : "sans image"));
        video.setOnErrorListener((mp, what, extra) -> { result("video", "erreur " + what + "/" + extra); return true; });
        video.setVideoPath(f.getAbsolutePath());
        video.start();
    }

    // ---------- Voix d'Android (lit les messages quand la voix enregistrée manque) ----------

    private void voix() {
        message("Contrôle de la voix", "La tablette lit une phrase avec sa propre voix.");
        media(volume);
        tts = new android.speech.tts.TextToSpeech(getApplicationContext(), status -> {
            if (status != android.speech.tts.TextToSpeech.SUCCESS) { result("voix", "erreur moteur"); return; }
            int langue = tts.setLanguage(java.util.Locale.FRANCE);
            if (langue < 0) { result("voix", "pas de voix française"); return; }
            tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { result("voix", "ok"); }
                @Override public void onError(String id) { result("voix", "erreur lecture"); }
            });
            tts.speak("Bonjour, ceci est un essai de la voix de la tablette.", android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "essai");
        });
    }

    // ---------- Haut-parleur et micro sans personne : le micro doit entendre la tablette parler ----------

    private void boucle() {
        message("Contrôle du son et du micro", "La tablette s'écoute parler.");
        media(volume);
        new Thread(() -> {
            int rate = 16000;
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            short[] buf = new short[2048];
            int calme = 0, son = 0;
            AudioRecord rec = null;
            MediaPlayer mp = null;
            try {
                rec = new AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 4096));
                rec.startRecording();
                // 1 s de silence (bruit de la pièce), puis la phrase d'accueil jouée et écoutée.
                long fin = System.currentTimeMillis() + 1000;
                while (System.currentTimeMillis() < fin && !stop) calme = Math.max(calme, crete(rec, buf));
                mp = new MediaPlayer();
                android.content.res.AssetFileDescriptor fd = getAssets().openFd("bienvenue/voix/accueil.mp3");
                mp.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
                fd.close();
                mp.prepare();
                mp.start();
                fin = System.currentTimeMillis() + Math.min(6000, Math.max(1500, mp.getDuration()));
                while (System.currentTimeMillis() < fin && !stop) son = Math.max(son, crete(rec, buf));
            } catch (Exception e) {
                Log.w(TAG, "Boucle", e);
                result("boucle", "erreur " + e.getMessage());
                return;
            } finally {
                if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
                if (mp != null) { try { mp.release(); } catch (Exception ignored) { } }
            }
            if (!stop) result("boucle", "calme " + calme + " son " + son);
        }, "papote-controle-boucle").start();
    }

    private static int crete(AudioRecord rec, short[] buf) {
        int n = rec.read(buf, 0, buf.length), peak = 0;
        for (int i = 0; i < n; i++) peak = Math.max(peak, Math.abs((int) buf[i]));
        return peak;
    }

    // ---------- Bilan affiché sur la tablette (lignes « Nom=ok|ko », en base64 pour adb) ----------

    private void bilan(String b64) {
        String texte = "";
        try { texte = new String(android.util.Base64.decode(b64 == null ? "" : b64, android.util.Base64.DEFAULT), StandardCharsets.UTF_8); }
        catch (Exception ignored) { }
        StringBuilder ko = new StringBuilder();
        for (String ligne : texte.split("\n")) {
            int i = ligne.lastIndexOf('=');
            if (i > 0 && !"ok".equals(ligne.substring(i + 1).trim())) ko.append("• ").append(ligne.substring(0, i)).append('\n');
        }
        TextView sub = message(ko.length() == 0 ? "Tout est prêt ✓" : "À vérifier",
                ko.length() == 0 ? "La tablette peut partir." : ko.toString().trim());
        if (ko.length() > 0) sub.setTextColor(Color.parseColor("#B42318"));
        sub.setGravity(ko.length() == 0 ? Gravity.CENTER : Gravity.START);
        root.setOnClickListener(v -> finish()); // un toucher rend la main à Papote
    }

    private void cleanup() {
        stop = true;
        releaseCamera();
        if (player != null) { try { player.release(); } catch (Exception ignored) { } player = null; }
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        if (video != null) { video.stopPlayback(); video = null; }
        if (tts != null) { tts.shutdown(); tts = null; }
        root.setOnClickListener(null);
    }

    @Override
    protected void onDestroy() {
        cleanup();
        super.onDestroy();
    }
}
