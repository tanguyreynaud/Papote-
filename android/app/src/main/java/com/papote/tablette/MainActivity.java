package com.papote.tablette;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Plein écran sur la page tablette de Papote, verrouillé en mode kiosque
 * quand l'app est propriétaire de l'appareil (« device owner »).
 *
 * Commandes de maintenance par ADB (voir installation/README.md) :
 *   --es code ABCD2345     relie la tablette à une famille
 *   --ez unlock true       sort du mode kiosque jusqu'au prochain redémarrage de l'app
 *   --ez remove_owner true retire le mode kiosque définitivement (avant désinstallation)
 */
public class MainActivity extends Activity {
    private static final String TAG = "Papote";
    private static final String HOST = "papote-famille.web.app";
    private static final String BASE_URL = "https://" + HOST + "/tablette.html";
    private static final long RETRY_MS = 20_000;

    private WebView web;
    private SharedPreferences prefs;
    private boolean kioskPaused = false;
    private boolean loadFailed = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("papote", MODE_PRIVATE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#FFF8F1"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setWebViewClient(new KioskClient());
        setContentView(web);

        handleIntent(getIntent());
        setupDeviceOwner();
        watchNetwork();
        load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleIntent(intent)) load();
    }

    /** Retourne true si l'adresse de la page a changé. */
    private boolean handleIntent(Intent intent) {
        if (intent == null) return false;
        if (intent.getBooleanExtra("remove_owner", false)) {
            removeDeviceOwner();
            return false;
        }
        if (intent.getBooleanExtra("unlock", false)) {
            kioskPaused = true;
            try { stopLockTask(); } catch (Exception e) { Log.w(TAG, "stopLockTask", e); }
            return false;
        }
        if (intent.getBooleanExtra("lock", false)) {
            kioskPaused = false;
            enterKiosk();
        }
        String code = intent.getStringExtra("code");
        if (code != null && !code.trim().isEmpty()) {
            prefs.edit().putString("code", code.trim()).apply();
            return true;
        }
        return false;
    }

    private String pageUrl() {
        String code = prefs.getString("code", null);
        if (code == null) return BASE_URL;
        // Le code est renvoyé à chaque chargement : si les données de la page sont effacées,
        // la tablette se reconnecte toute seule à la famille.
        return BASE_URL + "?code=" + Uri.encode(code);
    }

    private void load() {
        loadFailed = false;
        web.getSettings().setCacheMode(isOnline()
                ? WebSettings.LOAD_DEFAULT
                : WebSettings.LOAD_CACHE_ELSE_NETWORK);
        web.loadUrl(pageUrl());
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> { if (loadFailed) load(); });
            }
        };
        cm.registerDefaultNetworkCallback(networkCallback);
    }

    private class KioskClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // On reste sur Papote : aucun lien ne doit faire sortir de l'app.
            return !HOST.equals(request.getUrl().getHost());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            loadFailed = true;
            view.loadDataWithBaseURL(null, offlinePage(), "text/html", "utf-8", null);
            handler.removeCallbacksAndMessages(null);
            handler.postDelayed(MainActivity.this::load, RETRY_MS);
        }
    }

    private static String offlinePage() {
        return "<html><body style=\"margin:0;height:100vh;display:flex;flex-direction:column;"
                + "align-items:center;justify-content:center;background:#fff8f1;color:#1f1a17;"
                + "font-family:sans-serif;text-align:center\">"
                + "<p style=\"font-size:7vmin;font-weight:bold;margin:0\">Pas de connexion internet</p>"
                + "<p style=\"font-size:4.5vmin;color:#5c5049\">La tablette réessaie toute seule.</p>"
                + "</body></html>";
    }

    // ---------- Mode kiosque ----------

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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // Garde le menu du bouton marche/arrêt pour pouvoir éteindre ou redémarrer.
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS);
            }
            IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addCategory(Intent.CATEGORY_DEFAULT);
            dpm.addPersistentPreferredActivity(admin, home,
                    new ComponentName(getPackageName(), MainActivity.class.getName()));
            dpm.setKeyguardDisabled(admin, true);
            dpm.setStatusBarDisabled(admin, true);
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
            stopLockTask();
        } catch (Exception ignored) { }
        try {
            dpm.clearPackagePersistentPreferredActivities(admin, getPackageName());
            dpm.setKeyguardDisabled(admin, false);
            dpm.setStatusBarDisabled(admin, false);
            dpm.setLockTaskPackages(admin, new String[0]);
        } catch (Exception e) {
            Log.w(TAG, "Nettoyage du kiosque", e);
        }
        dpm.clearDeviceOwnerApp(getPackageName());
        kioskPaused = true;
    }

    private void enterKiosk() {
        if (kioskPaused || !dpm().isLockTaskPermitted(getPackageName())) return;
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
            try { startLockTask(); } catch (Exception e) { Log.w(TAG, "startLockTask", e); }
        }
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
    }

    @Override
    protected void onDestroy() {
        if (networkCallback != null) {
            ((ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE))
                    .unregisterNetworkCallback(networkCallback);
        }
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // Le bouton retour ne fait rien : l'accueil est toujours accessible dans la page.
    }
}
