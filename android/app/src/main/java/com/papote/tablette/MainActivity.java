package com.papote.tablette;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.UserManager;
import android.os.PowerManager;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.Manifest;
import android.content.pm.PackageManager;
import android.widget.FrameLayout;
import android.widget.VideoView;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * Écran Papote en plein écran. L'interface est une page locale (assets/tablette.html) ;
 * les données (Firebase, météo) sont récupérées par {@link Sync} en Java.
 * Prévu pour des tablettes récentes (Android 9 et plus) en mode kiosque (propriétaire de l'appareil).
 *
 * Commandes de maintenance par ADB (voir README.md) :
 *   --es code ABCD2345     relie la tablette à une famille (code tablette, créé dans l'app famille)
 *   --ez unlock true       sort du mode kiosque jusqu'au prochain « lock »
 *   --ez lock true         revient en mode kiosque
 *   --ez remove_owner true retire le mode kiosque définitivement (avant désinstallation)
 */
public class MainActivity extends Activity implements Sync.Listener {
    private static final String TAG = "Papote";

    private WebView web;
    private SharedPreferences prefs;
    private Sync sync;
    private CallAudio callAudio;
    private VoicePlayer voicePlayer;
    private VideoView videoView;
    private Wifi wifi;
    private SmsAlert smsAlert;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("papote", MODE_PRIVATE);
        Journal.catchCrashes(this);
        Journal.log(this, "Démarrage de Papote " + appVersionName());

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);

        // Inspection de la page depuis Chrome (chrome://inspect), seulement pour les versions de test.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#FDFAF5"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setHapticFeedbackEnabled(false);
        web.addJavascriptInterface(new Bridge(), "PapoteAndroid");
        web.setWebViewClient(new WebViewClient() {
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true; // aucun lien ne fait sortir de l'écran Papote
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @SuppressWarnings("deprecation")
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return LocalContent.intercept(MainActivity.this, Uri.parse(url));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return LocalContent.intercept(MainActivity.this, request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Messages et erreurs de la page dans logcat (adb logcat -s PapoteJS).
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i("PapoteJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }

            // Caméra et micro pour les appels vidéo, uniquement pour l'écran Papote.
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (LocalContent.HOST.equals(request.getOrigin().getHost())) {
                    request.grant(request.getResources());
                } else {
                    request.deny();
                }
            }
        });
        // La page, et par-dessus un lecteur vidéo natif plein écran.
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        videoView = new VideoView(this);
        videoView.setVisibility(View.GONE);
        FrameLayout.LayoutParams vlp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
        vlp.gravity = Gravity.CENTER;
        root.setBackgroundColor(Color.BLACK);
        root.addView(videoView, vlp);
        videoView.setOnCompletionListener(mp -> endVideo());
        videoView.setOnErrorListener((mp, what, extra) -> {
            Log.w(TAG, "Lecture vidéo impossible " + what + "/" + extra);
            endVideo();
            return true;
        });
        // Toucher la vidéo l'arrête.
        videoView.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_UP) endVideo();
            return true;
        });
        setContentView(root);
        callAudio = new CallAudio(this);
        voicePlayer = new VoicePlayer(this, () -> callPage("onVoiceEnded", new JSONObject()));
        if ((checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)) {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 1);
        }

        sync = new Sync(this, prefs, this);
        wifi = new Wifi(this, admin());
        smsAlert = new SmsAlert(this, prefs, wifi);
        handleIntent(getIntent());
        setupDeviceOwner();
        setVolumes();
        registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        handler.postDelayed(daytimeWatch, 60_000);
        web.loadUrl(LocalContent.PAGE);
        sync.start();
        Updater.cleanup(this);
        handler.postDelayed(updateCheck, 60_000);
    }

    /** Toutes les 6 heures : une nouvelle version de Papote est-elle publiée ? */
    private final Runnable updateCheck = new Runnable() {
        @Override
        public void run() {
            if (isDeviceOwner()) {
                new Thread(() -> Updater.check(getApplicationContext()), "papote-maj").start();
            }
            handler.postDelayed(this, 6 * 3600_000L);
        }
    };

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("remove_owner", false)) {
            setKioskPaused(true);
            removeDeviceOwner();
        }
        if (intent.getBooleanExtra("unlock", false)) setKioskPaused(true);
        if (intent.getBooleanExtra("lock", false)) setKioskPaused(false);
        // Remise sur l'écran Bienvenue (test du parcours client) : quitte la famille, sans rien effacer d'autre.
        if (intent.getBooleanExtra("bienvenue", false) && sync != null) {
            sync.resetToWelcome();
            callPage("onLeave", new JSONObject());
            // La page repart de zéro (appels compris) : plus rien de l'ancienne famille en mémoire.
            handler.postDelayed(() -> {
                android.webkit.WebStorage.getInstance().deleteAllData();
                if (web != null) web.reload();
            }, 1500);
            return;
        }
        if (intent.getBooleanExtra("leave", false) && sync != null) {
            sync.leave();
            callPage("onLeave", new JSONObject());
            return;
        }
        String canal = intent.getStringExtra("canal");
        if (canal != null) prefs.edit().putString("canal", "test".equals(canal) ? "test" : "").apply();
        String numbers = intent.getStringExtra("numeros");
        if (numbers != null) prefs.edit().putString("alertNumbers", numbers.replaceAll("[^0-9+,]", "")).apply();
        String code = intent.getStringExtra("code");
        if (code != null) {
            code = code.toUpperCase().replaceAll("[^A-Z0-9]", "");
            if (code.length() == 8 && !code.equals(prefs.getString("code", null))) {
                prefs.edit().putString("code", code).apply();
                if (sync != null) sync.reset();
            }
        }
    }

    // ---------- Lien avec la page ----------

    private final class Bridge {
        @JavascriptInterface
        public void ready() {
            sync.resend();
        }

        @JavascriptInterface
        public void markSeen(String id) {
            sync.markSeen(id, false);
        }

        @JavascriptInterface
        public void sendHeart(String id) {
            sync.markSeen(id, true);
        }

        @JavascriptInterface
        public void reply(String postId, String text) {
            sync.reply(postId, text);
        }

        @JavascriptInterface
        public void playVoice(String url) {
            handler.post(() -> voicePlayer.play(url));
        }

        @JavascriptInterface
        public void playVideo(String url) {
            handler.post(() -> startVideo(url));
        }

        @JavascriptInterface
        public void stopVideo() {
            handler.post(() -> {
                videoView.stopPlayback();
                videoView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
            });
        }

        /** QR code (image PNG en data URL) du lien d'invitation de la famille. */
        @JavascriptInterface
        public String qrCode(String text) {
            try {
                com.google.zxing.common.BitMatrix m = new com.google.zxing.qrcode.QRCodeWriter()
                        .encode(text, com.google.zxing.BarcodeFormat.QR_CODE, 480, 480);
                int w = m.getWidth(), h = m.getHeight();
                int[] pixels = new int[w * h];
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) pixels[y * w + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
                }
                android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(pixels, w, h,
                        android.graphics.Bitmap.Config.ARGB_8888);
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
                return "data:image/png;base64," + android.util.Base64.encodeToString(out.toByteArray(),
                        android.util.Base64.NO_WRAP);
            } catch (Exception e) {
                Log.w(TAG, "QR code", e);
                return "";
            }
        }

        /** La nuit : écran noir et luminosité au minimum ; le jour : luminosité normale. */
        @JavascriptInterface
        public void setSleep(boolean asleep) {
            Journal.log(MainActivity.this, asleep ? "Veille de nuit : écran noir" : "Fin de la veille de nuit");
            handler.post(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                float brightness = asleep ? 0.01f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                lp.screenBrightness = brightness;
                getWindow().setAttributes(lp);
            });
        }

        @JavascriptInterface
        public void stopVoice() {
            handler.post(() -> voicePlayer.stop());
        }

        /** La page écoute la famille en direct (Firebase web). */
        @JavascriptInterface
        public void realtime(boolean on) {
            sync.setRealtime(on);
        }

        /** Quelque chose a changé dans la famille : synchroniser tout de suite. */
        @JavascriptInterface
        public void changed() {
            sync.poke();
        }

        @JavascriptInterface
        public void morePhotos() {
            sync.morePhotos();
        }

        @JavascriptInterface
        public void touched() {
            sync.touched();
        }

        @JavascriptInterface
        public void ackReminder(String id, String when) {
            sync.ackReminder(id, when);
        }

        /** Son de notification et écran allumé (rappel à l'heure). */
        @JavascriptInterface
        public void alert() {
            onNewArrival();
        }

        @JavascriptInterface
        public String getCode() {
            return prefs.getString("code", null);
        }

        /** Compte e-mail et mot de passe réservé aux appels vidéo (appels.js), en JSON. */
        @JavascriptInterface
        public String callsAccount() {
            return sync.callsAccount();
        }

        // ---------- Écran Bienvenue (première installation chez le client) ----------

        @JavascriptInterface
        public void setTabletName(String name) {
            if (name != null && !name.trim().isEmpty()) sync.setTabletName(name.length() > 40 ? name.substring(0, 40) : name);
        }

        @JavascriptInterface
        public String wifiScan() {
            return wifi.scan();
        }

        @JavascriptInterface
        public boolean wifiConnect(String ssid, String password) {
            return wifi.connect(ssid, password);
        }

        @JavascriptInterface
        public String wifiStatus() {
            return wifi.status();
        }

        /** Code PIN de la famille (donné à l'installation) pour régler le wifi plus tard. */
        /** Erreurs de la page, notées dans le journal. */
        @JavascriptInterface
        public void logError(String message) {
            Journal.log(MainActivity.this, "Erreur page : " + message);
        }


        @JavascriptInterface
        public void wifiDone() {
            sync.wifiDone();
        }

        @JavascriptInterface
        public void confirmPairing(boolean yes) {
            sync.confirmPairing(yes);
        }

        /** Code d'appairage en cours (pour l'inscription du compte des appels), ou null. */
        @JavascriptInterface
        public String getPairing() {
            return sync.pairingCode();
        }

        @JavascriptInterface
        public void ring(boolean on) {
            // Papote en pause (abonnement) : pas de sonnerie.
            if (on && sync.paused()) return;
            handler.post(() -> callAudio.ring(on));
        }

        @JavascriptInterface
        public void inCall(boolean on) {
            handler.post(() -> callAudio.inCall(on));
        }
    }

    private void callPage(final String function, final JSONObject payload) {
        // JSON est du JavaScript valide, sauf les séparateurs de ligne Unicode.
        final String json = payload.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        handler.post(() -> {
            if (web == null) return;
            String js = "window.Papote && Papote." + function + "(" + json + ")";
            web.evaluateJavascript(js, null);
        });
    }

    @Override public void onStatus(JSONObject status) { callPage("onStatus", status); }
    @Override public void onPosts(JSONObject payload) { callPage("onPosts", payload); }
    @Override public void onWeather(JSONObject weather) { callPage("onWeather", weather); }

    private void startVideo(String url) {
        String name = Uri.parse(url).getLastPathSegment();
        if (name == null || name.contains("..")) return;
        java.io.File file = new java.io.File(new java.io.File(getFilesDir(), "photos"), name);
        if (!file.exists()) {
            endVideo();
            return;
        }
        // Rien derrière la vidéo : la page est masquée, le fond reste noir.
        web.setVisibility(View.INVISIBLE);
        videoView.setVisibility(View.VISIBLE);
        videoView.setVideoPath(file.getAbsolutePath());
        videoView.start();
    }

    private void endVideo() {
        videoView.stopPlayback();
        videoView.setVisibility(View.GONE);
        if (web != null) web.setVisibility(View.VISIBLE);
        callPage("onVoiceEnded", new JSONObject());
    }
    @Override public void onReminders(JSONObject payload) { callPage("onReminders", payload); }
    @Override public void onFamily(JSONObject payload) { callPage("onFamily", payload); }

    /** Nouvel envoi : on allume l'écran et on joue le son de notification de la tablette. */
    @SuppressWarnings("deprecation")
    @Override
    public void onNewArrival() {
        // La nuit (23h-7h), pas de sonnerie ni d'écran allumé : l'envoi attend le matin.
        int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        if (hour >= 23 || hour < 7) return;
        handler.post(() -> {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP, "papote:nouveau");
                wl.acquire(15_000);
            } catch (Exception e) {
                Log.w(TAG, "Réveil de l'écran", e);
            }
            try {
                Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                Ringtone r = RingtoneManager.getRingtone(this, sound);
                if (r != null) r.play();
            } catch (Exception e) {
                Log.w(TAG, "Son de notification", e);
            }
        });
    }

    // ---------- Mode kiosque ----------

    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    private static final String[] RESTRICTIONS = {
            UserManager.DISALLOW_OUTGOING_CALLS,
            UserManager.DISALLOW_SAFE_BOOT,
    };

    // ---------- Son et écran : ni réglables ni éteignables par erreur ----------

    /** Volume réglé une fois pour toutes : fort pour la sonnerie et les messages vocaux. */
    private void setVolumes() {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int[][] levels = {
                {AudioManager.STREAM_MUSIC, 85}, {AudioManager.STREAM_RING, 100},
                {AudioManager.STREAM_NOTIFICATION, 90}, {AudioManager.STREAM_VOICE_CALL, 100},
                {AudioManager.STREAM_ALARM, 100},
        };
        for (int[] l : levels) {
            try {
                am.setStreamVolume(l[0], am.getStreamMaxVolume(l[0]) * l[1] / 100, 0);
            } catch (Exception e) {
                Log.w(TAG, "Volume " + l[0], e);
            }
        }
    }

    /** Les boutons de volume ne font rien : le son reste au bon niveau. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN
                || code == KeyEvent.KEYCODE_VOLUME_MUTE) {
            return !kioskPaused();
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * Android ne laisse aucune appli bloquer le bouton marche/arrêt : un appui éteint l'écran.
     * En journée, on le rallume dans la foulée (on ne voit qu'un bref noir).
     * La nuit (23h-7h), on le laisse éteint.
     */
    private final android.content.BroadcastReceiver screenOff = new android.content.BroadcastReceiver() {
        @SuppressWarnings("deprecation")
        @Override
        public void onReceive(Context context, Intent intent) {
            int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
            Journal.log(MainActivity.this, "Écran éteint (bouton marche/arrêt ou système)");
            if (kioskPaused() || hour >= 23 || hour < 7) return;
            handler.post(() -> {
                try {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm.isInteractive()) return;
                    PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP, "papote:rallumer");
                    wl.acquire(5_000);
                } catch (Exception e) {
                    Log.w(TAG, "Rallumer l'écran", e);
                }
            });
        }
    };

    private boolean kioskPaused() {
        return prefs.getBoolean("kioskPaused", false);
    }

    private void setKioskPaused(boolean paused) {
        prefs.edit().putBoolean("kioskPaused", paused).apply();
        if (paused) {
            try { stopLockTask(); } catch (Exception e) { Log.w(TAG, "stopLockTask", e); }
        } else {
            enterKiosk();
        }
    }

    private ComponentName admin() {
        return new ComponentName(this, AdminReceiver.class);
    }

    private DevicePolicyManager dpm() {
        return (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
    }

    private boolean isDeviceOwner() {
        return dpm().isDeviceOwnerApp(getPackageName());
    }

    private void setupDeviceOwner() {
        if (!isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        try {
            dpm.setLockTaskPackages(admin, new String[]{getPackageName()});
            // Pas de menu « Éteindre / Redémarrer » sur le bouton marche/arrêt.
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            // Pas d'appel ni de SMS par la carte SIM : tout passe par Papote.
            for (String r : RESTRICTIONS) dpm.addUserRestriction(admin, r);
            // Les SMS servent aux alertes de Papote : plus bloqués (l'appli Messages reste désactivée,
            // rien ne s'affiche). Envoi autorisé d'office.
            dpm.clearUserRestriction(admin, UserManager.DISALLOW_SMS);
            dpm.setPermissionGrantState(admin, getPackageName(), Manifest.permission.SEND_SMS,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addCategory(Intent.CATEGORY_DEFAULT);
            dpm.addPersistentPreferredActivity(admin, home,
                    new ComponentName(getPackageName(), MainActivity.class.getName()));
            dpm.setKeyguardDisabled(admin, true);
            dpm.setStatusBarDisabled(admin, true);
            // Luminosité automatique en journée, si la tablette a un capteur de lumière.
            android.hardware.SensorManager sm = (android.hardware.SensorManager) getSystemService(SENSOR_SERVICE);
            if (sm != null && sm.getDefaultSensor(android.hardware.Sensor.TYPE_LIGHT) != null) {
                dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE,
                        String.valueOf(Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC));
            }
            // Écran toujours allumé quand la tablette est branchée (secteur, USB ou sans fil).
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7");
        } catch (Exception e) {
            Log.w(TAG, "Configuration du kiosque incomplète", e);
        }
    }

    private void removeDeviceOwner() {
        if (!isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        try {
            dpm.clearPackagePersistentPreferredActivities(admin, getPackageName());
            for (String r : RESTRICTIONS) dpm.clearUserRestriction(admin, r);
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS);
            dpm.setKeyguardDisabled(admin, false);
            dpm.setStatusBarDisabled(admin, false);
            dpm.setLockTaskPackages(admin, new String[0]);
        } catch (Exception e) {
            Log.w(TAG, "Nettoyage du kiosque", e);
        }
        dpm.clearDeviceOwnerApp(getPackageName());
    }

    private void enterKiosk() {
        if (kioskPaused() || !isDeviceOwner() || !dpm().isLockTaskPermitted(getPackageName())) return;
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
            try { startLockTask(); } catch (Exception e) { Log.w(TAG, "startLockTask", e); }
        }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
            }
        }
    }

    /**
     * La barre du haut peut rester affichée après un glissement depuis le bord :
     * on la masque de nouveau dès qu'elle apparaît, puis toutes les 3 secondes par sécurité.
     */
    private final Runnable rehideBars = new Runnable() {
        @Override
        public void run() {
            hideSystemBars();
            handler.postDelayed(this, 3000);
        }
    };

    /**
     * Chaque minute : en journée (7h-23h), l'écran doit être allumé, à luminosité normale.
     * Rallume l'écran le matin s'il s'est éteint dans la nuit (bouton, coupure), et rétablit
     * la luminosité si la page n'a pas pu le faire elle-même.
     */
    private final Runnable daytimeWatch = new Runnable() {
        @SuppressWarnings("deprecation")
        @Override
        public void run() {
            handler.postDelayed(this, 60_000);
            final SmsAlert alert = smsAlert;
            if (alert != null) new Thread(alert::check, "papote-sms").start();
            int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
            if (kioskPaused() || hour < 7 || hour >= 23) return;
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (!pm.isInteractive()) {
                    Log.i(TAG, "Journée : on rallume l'écran");
                    Journal.log(MainActivity.this, "Journée : écran trouvé éteint, rallumé");
                    PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP, "papote:matin");
                    wl.acquire(10_000);
                }
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                if (lp.screenBrightness >= 0 && lp.screenBrightness < 0.05f) {
                    lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                    getWindow().setAttributes(lp);
                }
            } catch (Exception e) {
                Log.w(TAG, "Réveil du matin", e);
            }
        }
    };

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        handler.removeCallbacks(rehideBars);
        handler.post(rehideBars);
        enterKiosk();
    }

    @Override
    protected void onPause() {
        web.onPause();
        handler.removeCallbacks(rehideBars);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(screenOff); } catch (Exception ignored) { }
        callAudio.release();
        voicePlayer.stop();
        sync.stop();
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        web = null;
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // Le bouton retour ne fait rien : l'accueil est toujours accessible dans la page.
    }
}
