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
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
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
 * les données (Firebase, météo) sont récupérées par {@link Sync} en Java, ce qui marche
 * aussi sur les tablettes anciennes (Android 4.4).
 *
 * Commandes de maintenance par ADB (voir README.md) :
 *   --es code ABCD2345     relie la tablette à une famille
 *   --ez unlock true       sort du mode kiosque jusqu'au prochain « lock »
 *   --ez lock true         revient en mode kiosque
 *   --ez remove_owner true retire le mode kiosque définitivement (avant désinstallation)
 */
public class MainActivity extends Activity implements Sync.Listener {
    private static final String TAG = "Papote";

    private WebView web;
    private SharedPreferences prefs;
    private Sync sync;
    private View statusBarBlocker;
    private CallAudio callAudio;
    private VoicePlayer voicePlayer;
    private VideoView videoView;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("papote", MODE_PRIVATE);

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
        web.setBackgroundColor(Color.parseColor("#FFF8F1"));
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
            // Caméra et micro pour les appels vidéo, uniquement pour l'écran Papote.
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= 21
                        && LocalContent.HOST.equals(request.getOrigin().getHost())) {
                    request.grant(request.getResources());
                } else if (Build.VERSION.SDK_INT >= 21) {
                    request.deny();
                }
            }
        });
        // La page, et par-dessus un lecteur vidéo natif (le navigateur d'Android 4.4 ne lit pas
        // les vidéos servies localement).
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
        if (Build.VERSION.SDK_INT >= 23
                && (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)) {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 1);
        }

        sync = new Sync(this, prefs, this);
        handleIntent(getIntent());
        setupDeviceOwner();
        web.loadUrl(LocalContent.PAGE);
        sync.start();
        Updater.cleanup(this);
        handler.postDelayed(updateCheck, 60_000);
    }

    /** Toutes les 6 heures : une nouvelle version de Papote est-elle publiée ? */
    private final Runnable updateCheck = new Runnable() {
        @Override
        public void run() {
            final boolean owner = isDeviceOwner();
            new Thread(() -> Updater.check(getApplicationContext(), owner), "papote-maj").start();
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
        if (intent.getBooleanExtra("leave", false) && sync != null) {
            sync.leave();
            callPage("onLeave", new JSONObject());
            return;
        }
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

        /** La nuit : écran noir et luminosité au minimum ; le jour : luminosité normale. */
        @JavascriptInterface
        public void setSleep(boolean asleep) {
            handler.post(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                float brightness = asleep ? 0.01f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                lp.screenBrightness = brightness;
                getWindow().setAttributes(lp);
                // Android 4.4 : la bande qui bloque la barre d'état est une fenêtre système placée
                // au-dessus ; c'est elle qui décide de la luminosité.
                if (statusBarBlocker != null) {
                    try {
                        WindowManager.LayoutParams blp = (WindowManager.LayoutParams) statusBarBlocker.getLayoutParams();
                        blp.screenBrightness = brightness;
                        ((WindowManager) getSystemService(WINDOW_SERVICE)).updateViewLayout(statusBarBlocker, blp);
                    } catch (Exception e) {
                        Log.w(TAG, "Luminosité de nuit", e);
                    }
                }
            });
        }

        @JavascriptInterface
        public void stopVoice() {
            handler.post(() -> voicePlayer.stop());
        }

        /** La page écoute la famille en direct (tablettes récentes). */
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

        @JavascriptInterface
        public void ring(boolean on) {
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

    private boolean kioskPaused() {
        return prefs.getBoolean("kioskPaused", false);
    }

    private void setKioskPaused(boolean paused) {
        prefs.edit().putBoolean("kioskPaused", paused).apply();
        if (paused) {
            if (Build.VERSION.SDK_INT >= 21) {
                try { stopLockTask(); } catch (Exception e) { Log.w(TAG, "stopLockTask", e); }
            }
            removeStatusBarBlocker();
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
        return Build.VERSION.SDK_INT >= 21 && dpm().isDeviceOwnerApp(getPackageName());
    }

    private void setupDeviceOwner() {
        if (Build.VERSION.SDK_INT < 21 || !isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        try {
            dpm.setLockTaskPackages(admin, new String[]{getPackageName()});
            if (Build.VERSION.SDK_INT >= 28) {
                // Garde le menu du bouton marche/arrêt pour pouvoir éteindre ou redémarrer.
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS);
            }
            IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addCategory(Intent.CATEGORY_DEFAULT);
            dpm.addPersistentPreferredActivity(admin, home,
                    new ComponentName(getPackageName(), MainActivity.class.getName()));
            if (Build.VERSION.SDK_INT >= 23) {
                dpm.setKeyguardDisabled(admin, true);
                dpm.setStatusBarDisabled(admin, true);
            }
            // Écran toujours allumé quand la tablette est branchée (secteur, USB ou sans fil).
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7");
        } catch (Exception e) {
            Log.w(TAG, "Configuration du kiosque incomplète", e);
        }
    }

    private void removeDeviceOwner() {
        if (Build.VERSION.SDK_INT < 21 || !isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        try {
            dpm.clearPackagePersistentPreferredActivities(admin, getPackageName());
            if (Build.VERSION.SDK_INT >= 23) {
                dpm.setKeyguardDisabled(admin, false);
                dpm.setStatusBarDisabled(admin, false);
            }
            dpm.setLockTaskPackages(admin, new String[0]);
        } catch (Exception e) {
            Log.w(TAG, "Nettoyage du kiosque", e);
        }
        dpm.clearDeviceOwnerApp(getPackageName());
    }

    private void enterKiosk() {
        if (kioskPaused()) return;
        if (Build.VERSION.SDK_INT >= 21 && isDeviceOwner()
                && (Build.VERSION.SDK_INT < 23 || dpm().isLockTaskPermitted(getPackageName()))) {
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            boolean locked = Build.VERSION.SDK_INT >= 23
                    ? am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE
                    : am.isInLockTaskMode();
            if (!locked) {
                try { startLockTask(); } catch (Exception e) { Log.w(TAG, "startLockTask", e); }
            }
        } else if (Build.VERSION.SDK_INT < 23) {
            addStatusBarBlocker();
        }
    }

    /**
     * Sans mode kiosque (Android 4.4) : une bande invisible en haut de l'écran
     * empêche d'ouvrir le volet des notifications.
     */
    @SuppressWarnings("deprecation")
    private void addStatusBarBlocker() {
        if (statusBarBlocker != null) return;
        int height = (int) (40 * getResources().getDisplayMetrics().density);
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, height,
                WindowManager.LayoutParams.TYPE_SYSTEM_ERROR,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSPARENT);
        lp.gravity = Gravity.TOP;
        View v = new View(this) {
            @SuppressLint("ClickableViewAccessibility")
            @Override
            public boolean onTouchEvent(MotionEvent event) {
                return true;
            }
        };
        try {
            ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(v, lp);
            statusBarBlocker = v;
        } catch (Exception e) {
            Log.w(TAG, "Blocage de la barre d'état impossible", e);
        }
    }

    private void removeStatusBarBlocker() {
        if (statusBarBlocker == null) return;
        try {
            ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(statusBarBlocker);
        } catch (Exception ignored) { }
        statusBarBlocker = null;
    }

    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemBars();
        enterKiosk();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
        // Sans mode kiosque, si une autre app passe devant (bouton « récents »), on revient.
        if (!kioskPaused() && !isDeviceOwner()) {
            handler.postDelayed(() -> {
                // Laisse l'écran d'installation d'une mise à jour au premier plan.
                if (Updater.prompting()) return;
                ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
                am.moveTaskToFront(getTaskId(), 0);
            }, 800);
        }
    }

    @Override
    protected void onDestroy() {
        removeStatusBarBlocker();
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
