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
import android.os.SystemClock;
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

import org.json.JSONException;
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
    /** L'activité à l'écran (la tablette n'en a qu'une), pour les réveils du serveur (Push). */
    private static volatile MainActivity courante;
    private CallAudio callAudio;
    /** Luminosité le soir (0 à 1) ; vrai pendant les heures du soir. */
    private static final float EVENING_BRIGHTNESS = 0.55f;
    private boolean dimmed;
    private VoicePlayer voicePlayer;
    private VideoView videoView;
    /** Carillon d'arrivée en cours (null quand il a fini). */
    private volatile android.media.MediaPlayer carillon;
    /** Dernier « fenêtre ouverte » dit par la page (0 = aucune), et dernier carillon d'un envoi. */
    private volatile long fenetreVueA;
    private volatile long dernierCarillon;
    /** Envois arrivés ensemble (quelques secondes, avant que le premier s'affiche) : un seul carillon.
     * Sinon seul l'écran en cours compte (Tanguy, 29/10 : pas de pause de 90 s). */
    private static final long CARILLON_UNE_FOIS_MS = 10_000;
    private Wifi wifi;
    private SmsAlert smsAlert;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("papote", MODE_PRIVATE);
        courante = this;
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
        s.setAllowFileAccess(false); // tout passe par appassets.androidplatform.net (audit du 23/10)
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

            // Le moteur de la page s'est arrêté (manque de mémoire sur une petite tablette) : sans ceci,
            // Android ferme Papote. On note l'incident et on refait l'écran (la page repart, état renvoyé).
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                Journal.log(MainActivity.this, "Page arrêtée par Android (" + (detail.didCrash() ? "plantage" : "mémoire") + ") : écran refait");
                if (view == web) {
                    if (web.getParent() != null) ((android.view.ViewGroup) web.getParent()).removeView(web);
                    web.destroy();
                    web = null;
                }
                handler.post(MainActivity.this::recreate);
                return true;
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
        videoView.setOnPreparedListener(renfortVideo::sur);
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
        prepareTts();
        wifi = new Wifi(this, admin());
        smsAlert = new SmsAlert(this, prefs, wifi);
        handleIntent(getIntent());
        setupDeviceOwner();
        setVolumes();
        registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        IntentFilter power = new IntentFilter(Intent.ACTION_POWER_CONNECTED);
        power.addAction(Intent.ACTION_POWER_DISCONNECTED);
        registerReceiver(powerChange, power);
        handler.postDelayed(daytimeWatch, 60_000);
        web.loadUrl(LocalContent.PAGE);
        sync.start();
        Updater.cleanup(this);
        handler.postDelayed(updateCheck, 60_000);
        Push.demarrer(this);
        new Thread(() -> AppCheck.current(getApplicationContext()), "papote-appcheck").start();
        // Appels de la carte SIM : la page sonne et décroche (AppelGsm).
        AppelGsm.ecouter(this, (etat) -> {
            if (sync != null && sync.paused() && "sonne".equals(etat.optString("etat"))) {
                AppelGsm.raccrocher(); // Papote en pause (abonnement) : pas d'appel
                return;
            }
            callPage("onGsm", etat);
        });
    }

    /**
     * Une nouvelle version de Papote est-elle publiée ? Au démarrage, dès que la publication est
     * annoncée (config/version, écouté par la page : pont checkUpdate), et une fois par jour en secours.
     * En cas d'échec (wifi pas encore prêt au démarrage…), nouvel essai 10 min après.
     */
    private final Runnable updateCheck = new Runnable() {
        @Override
        public void run() {
            handler.removeCallbacks(this);
            if (!isDeviceOwner()) {
                Journal.log(MainActivity.this, "Mise à jour : Papote n'est pas propriétaire de l'appareil");
                handler.postDelayed(this, 24 * 3600_000L);
                return;
            }
            new Thread(() -> {
                // Forfait SIM presque épuisé (palier 3) : les 3 Mo de l'appli attendent le Wi-Fi ou la recharge.
                if (Forfait.economie(getApplicationContext(), 3)) {
                    handler.postDelayed(this, 6 * 3600_000L);
                    return;
                }
                boolean ok = Updater.check(getApplicationContext());
                handler.postDelayed(this, ok ? 24 * 3600_000L : 10 * 60_000L);
            }, "papote-maj").start();
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
        // Remise à l'état usine (installation/remettre-a-zero.ps1), pour rendre la tablette au fournisseur.
        // Le script écrit un code dans les réglages d'Android (settings global papote_usine, possible
        // seulement par câble) et envoie le même code : rien d'autre ne peut déclencher l'effacement.
        // (Ancienne façon, gardée : le n° de série, mais Android ne le donne pas toujours à l'appli.)
        String usine = intent.getStringExtra("usine");
        if (usine != null) {
            String jeton = Settings.Global.getString(getContentResolver(), "papote_usine");
            String serie = Sync.serialNumber();
            boolean autorise = usine.length() >= 8 && (usine.equals(jeton) || usine.equals(serie));
            if (!isDeviceOwner()) {
                Journal.log(this, "Remise à l'état usine refusée : Papote n'est pas en mode kiosque");
            } else if (!autorise) {
                Journal.log(this, "Remise à l'état usine refusée : code différent (n° de série lu : " + serie + ")");
            } else {
                Journal.log(this, "Remise à l'état usine demandée");
                try {
                    if (sync != null) sync.leave();
                } catch (Exception ignored) { }
                handler.postDelayed(() -> {
                    try {
                        dpm().wipeData(0);
                    } catch (Throwable e) {
                        Journal.log(this, "Remise à l'état usine impossible : " + e);
                        Log.w(TAG, "Remise à l'état usine", e);
                    }
                }, 4000);
            }
            return;
        }
        // Clé App Check de la tablette, posée par installer-tablette.ps1 (jamais écrite ailleurs).
        String appCheckKey = intent.getStringExtra("appCheckKey");
        if (appCheckKey != null && appCheckKey.matches("[A-Za-z0-9_-]{20,100}")) {
            AppCheck.saveKey(this, appCheckKey);
            Journal.log(this, "Clé App Check enregistrée");
        }
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
        String ville = intent.getStringExtra("ville");
        // Cherchée par la synchronisation dès qu'internet est là (script d'installation : -Ville).
        if (ville != null && !ville.trim().isEmpty()) prefs.edit().putString("meteoAChercher", ville.trim()).apply();
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

        /** Vidéo posée à un endroit de la page (x, y, largeur, hauteur en px CSS) ; plein : la page est masquée. */
        @JavascriptInterface
        public void playVideoAt(String url, float x, float y, float w, float h, boolean plein) {
            handler.post(() -> startVideo(url, new float[]{x, y, w, h}, plein));
        }

        @JavascriptInterface
        public void stopVideo() {
            handler.post(() -> {
                renfortVideo.arreter();
                videoView.stopPlayback();
                videoView.setVisibility(View.GONE);
                if (web != null) web.setVisibility(View.VISIBLE);
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
                float brightness = asleep ? 0.01f
                        : dimmed ? EVENING_BRIGHTNESS : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                lp.screenBrightness = brightness;
                getWindow().setAttributes(lp);
            });
        }

        /** Le soir (couleurs du soir) : écran moins lumineux ; le reste du temps, réglage normal. */
        @JavascriptInterface
        public void setDim(boolean on) {
            handler.post(() -> {
                dimmed = on;
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                if (lp.screenBrightness >= 0 && lp.screenBrightness < 0.05f) return; // veille de nuit en cours
                lp.screenBrightness = on ? EVENING_BRIGHTNESS : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
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

        /** Un visage est vu devant la tablette. */
        @JavascriptInterface
        public void seen() {
            sync.seen();
        }

        @JavascriptInterface
        public void ackReminder(String id, String when) {
            sync.ackReminder(id, when);
        }

        @JavascriptInterface
        public void seenReminder(String id, String when) {
            sync.seenReminder(id, when);
        }

        /** Son de notification et écran allumé (rappel à l'heure). */
        @JavascriptInterface
        public void alert() {
            // La nuit, un rappel sonne quand même, plus doucement (Tanguy, 26/10) ; un envoi, lui, attend le matin.
            // Un rappel sonne même si une fenêtre est ouverte : c'est l'heure (médicament, rendez-vous).
            float volume = Veille.isNight(MainActivity.this) ? 0.35f : 1f;
            handler.post(() -> sonner(volume));
        }

        /** La page redit chaque seconde si une fenêtre (envoi, rappel, appel…) est ouverte. */
        @JavascriptInterface
        public void fenetre(boolean ouverte) {
            fenetreVueA = ouverte ? SystemClock.elapsedRealtime() : 0;
        }

        /** Visage vu : le carillon (joué 5 fois) s'arrête tout de suite. */
        @JavascriptInterface
        public void carillonStop() {
            handler.post(MainActivity.this::stopCarillon);
        }

        /** Le carillon d'arrivée sonne-t-il encore ? La page attend la fin avant de parler. */
        @JavascriptInterface
        public boolean carillonEnCours() {
            return MainActivity.this.carillonEnCours();
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

        /** Ville de la météo (écran Bienvenue) : communes trouvées pour ce nom. */
        @JavascriptInterface
        public String meteoSearch(String query) {
            return sync.searchMeteo(query);
        }

        @JavascriptInterface
        public void meteoChoose(String name, double lat, double lon) {
            if (name != null && !name.trim().isEmpty()) sync.setMeteo(name.trim(), lat, lon);
        }

        @JavascriptInterface
        public void meteoSkip() {
            sync.setMeteo(null, 0, 0);
        }

        @JavascriptInterface
        public String wifiScan() {
            return wifi.scan();
        }

        @JavascriptInterface
        public boolean wifiConnect(String ssid, String password) {
            return wifi.connect(ssid, password);
        }

        /** Branchée sur secteur (chargeur, USB ou sans fil) : sinon la page demande de la brancher. */
        /** Base Firestore à utiliser par la page (appels) : « (default) » ou « eu » après la migration. */
        /** Lecture à voix haute d'un message (option « lecture »), en français. */
        @JavascriptInterface
        public void speak(String text) {
            handler.post(() -> { ttsPendingGuide = false; speakNow(text); });
        }

        /** Phrase du guide d'installation : dite même si le moteur de voix finit de démarrer. */
        @JavascriptInterface
        public void speakGuide(String text) {
            handler.post(() -> { ttsPendingGuide = true; speakNow(text); });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            // Seulement une vraie lecture : la page arrête la voix à chaque nouvel écran, ce qui
            // coupait aussi le préchargement (et la voix se chargeait au premier « Écouter »).
            // La phrase du guide d'installation en attente du moteur (démarrage) n'est pas annulée.
            handler.post(() -> { if (!ttsPendingGuide) ttsPending = null; if (tts != null && lectureEnCours) tts.stop(); });
        }

        /** Jeton App Check pour appels.js : {token, expireTimeMillis}, ou "" sans clé ni jeton. */
        /** Nouvelle version annoncée (config/version) : vérification tout de suite. */
        @JavascriptInterface
        public void checkUpdate() {
            handler.post(() -> {
                handler.removeCallbacks(updateCheck);
                handler.postDelayed(updateCheck, 5_000 + (long) (Math.random() * 60_000));
            });
        }

        @JavascriptInterface
        public boolean hasAppCheckKey() {
            return AppCheck.hasKey(getApplicationContext());
        }

        @JavascriptInterface
        public String appCheckToken() {
            JSONObject t = AppCheck.current(getApplicationContext());
            return t == null ? "" : t.toString();
        }

        @JavascriptInterface
        public String firestoreDatabase() {
            return Firebase.database();
        }

        @JavascriptInterface
        public boolean isCharging() {
            return Sync.pluggedIn(MainActivity.this);
        }

        @JavascriptInterface
        public String wifiStatus() {
            return wifi.status();
        }

        /** Garde-fou du forfait SIM (Forfait) : {plafondMo, consoMo, niveau, sim, cycleDebut}. */
        /** Le serveur réveille la tablette (Push) : la page n'a plus besoin d'écoute ouverte. */
        @JavascriptInterface
        public boolean pushReady() {
            return Push.pret(MainActivity.this);
        }

        @JavascriptInterface
        public String simBudget() {
            return Forfait.etat(MainActivity.this).toString();
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

        /** « Retour » : écran d'installation précédent. */
        @JavascriptInterface
        public void welcomeBack(boolean toStart) {
            sync.welcomeBack(toStart);
        }

        /** « Commencer » sur le premier écran de la tablette neuve. */
        @JavascriptInterface
        public void welcomeSeen() {
            sync.welcomeSeen();
        }

        /** « Recommencer avec un autre téléphone » pendant que le proche installe. */
        @JavascriptInterface
        public void cancelPairing() {
            sync.cancelPairing();
        }

        /**
         * Test du son demandé par le téléphone du proche (commande « son », lue par appels.js) :
         * « sonnerie » = 3 s de la sonnerie d'appel, « voix » = une phrase, au volume demandé (10-100).
         */
        @JavascriptInterface
        public void testSon(String quoi, int volume, String texte) {
            handler.post(() -> playSoundTest(quoi, volume, texte));
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

        // ----- Appels par la carte SIM (Telephone, AppelGsm) -----

        /** La tablette peut téléphoner (carte SIM prête, Papote application Téléphone). */
        @JavascriptInterface
        public boolean phoneReady() {
            return Telephone.pret(MainActivity.this);
        }

        /** Appelle ce numéro par la carte SIM ; la suite arrive par Papote.onGsm. false : l'appel n'est pas parti. */
        @JavascriptInterface
        public boolean phoneCall(String numero) {
            if (sync.paused() || AppelGsm.enCours()) return false;
            return Telephone.appeler(MainActivity.this, numero);
        }

        @JavascriptInterface
        public boolean phoneAnswer() {
            return AppelGsm.decrocher();
        }

        @JavascriptInterface
        public boolean phoneHangup() {
            return AppelGsm.raccrocher();
        }

        /** État de l'appel téléphonique en cours ({} s'il n'y en a pas), pour une page qui vient de se recharger. */
        @JavascriptInterface
        public String phoneState() {
            return AppelGsm.etat().toString();
        }

        /** Numéros de la famille connus de la tablette : [{uid, name, tel, responsable}]. */
        @JavascriptInterface
        public String phoneNumbers() {
            return Telephone.numeros(MainActivity.this).toString();
        }

        /** SMS du SOS aux numéros donnés (séparés par des virgules). */
        @JavascriptInterface
        public boolean sendSms(String numeros, String texte) {
            if (numeros == null || numeros.trim().isEmpty() || texte == null || texte.isEmpty()) return false;
            if (!wifi.hasSim()) return false;
            String n = numeros.replaceAll("[^0-9+,]", "");
            String t = texte.length() > 300 ? texte.substring(0, 300) : texte;
            return SmsAlert.envoyer(MainActivity.this, n, t);
        }
    }

    /** Réveil par le serveur (Push.onMessageReceived) ou nouveau jeton à écrire. */
    static void surPush(String type, String id) {
        MainActivity a = courante;
        if (a == null) return;
        a.handler.post(() -> {
            if (a.sync == null) return;
            switch (type) {
                case "famille":
                case "jeton":
                    a.sync.poke();
                    break;
                case "version":
                    a.handler.removeCallbacks(a.updateCheck);
                    a.handler.postDelayed(a.updateCheck, 5_000 + (long) (Math.random() * 60_000));
                    break;
                default: // appel, ordre : la page relit
                    try {
                        a.callPage("onPush", new JSONObject().put("type", type).put("id", id == null ? JSONObject.NULL : id));
                    } catch (JSONException ignored) { }
            }
        });
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
        startVideo(url, null, true);
    }

    private void startVideo(String url, float[] place, boolean plein) {
        String name = Uri.parse(url).getLastPathSegment();
        if (name == null || name.contains("..")) return;
        java.io.File file = new java.io.File(new java.io.File(getFilesDir(), "photos"), name);
        if (!file.exists()) {
            endVideo();
            return;
        }
        FrameLayout.LayoutParams lp;
        if (place != null && place[2] > 0 && place[3] > 0) {
            // Vidéo en hauteur : dans son cadre, à côté du mot. En largeur : toute la hauteur de l'écran,
            // les côtés qui dépassent sont coupés (la page donne la place exacte).
            float d = getResources().getDisplayMetrics().density;
            lp = new FrameLayout.LayoutParams(Math.round(place[2] * d), Math.round(place[3] * d));
            lp.gravity = Gravity.TOP | Gravity.LEFT;
            lp.leftMargin = Math.round(place[0] * d);
            lp.topMargin = Math.round(place[1] * d);
        } else {
            lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
            lp.gravity = Gravity.CENTER;
        }
        videoView.setLayoutParams(lp);
        // Plein écran : rien derrière la vidéo, la page est masquée, fond crème des écrans.
        ((View) videoView.getParent()).setBackgroundColor(0xFFF6EFE4);
        if (plein && web != null) web.setVisibility(View.INVISIBLE);
        videoView.setVisibility(View.VISIBLE);
        videoView.setVideoPath(file.getAbsolutePath());
        videoView.start();
    }

    private final Renfort renfortVideo = new Renfort();
    private final Renfort renfortCarillon = new Renfort();

    private void endVideo() {
        renfortVideo.arreter();
        videoView.stopPlayback();
        videoView.setVisibility(View.GONE);
        if (web != null) web.setVisibility(View.VISIBLE);
        callPage("onVoiceEnded", new JSONObject());
    }
    @Override public void onReminders(JSONObject payload) { callPage("onReminders", payload); }
    @Override public void onFamily(JSONObject payload) { callPage("onFamily", payload); }
    @Override public void onVolume(int volume) {
        handler.post(() -> { if (!essaiSon) setVolumes(); }); // pendant un essai du son, il garde son niveau
    }
    @Override public void onFamilyLost() { callPage("onFamilyLost", new JSONObject()); }

    /** Migration de la base : la page (appels compris) repart sur la nouvelle base. */
    @Override public void onDatabaseChanged(String database) {
        handler.post(() -> { if (web != null) web.reload(); });
    }

    /** Nouvel envoi : on allume l'écran et on joue le son de notification de la tablette. */
    @SuppressWarnings("deprecation")
    @Override
    public void onNewArrival() {
        // Pendant la veille (21h-6h30 sauf réglage de la famille), pas de sonnerie ni d'écran
        // allumé : l'envoi attend le matin.
        if (Veille.isNight(this)) return;
        handler.post(() -> {
            long now = SystemClock.elapsedRealtime();
            // Une fenêtre est déjà ouverte (envoi affiché, rappel…) : pas de carillon par-dessus,
            // l'envoi attend son tour dans la file (Tanguy, 29/10). Plusieurs envois arrivés ensemble :
            // un seul carillon, pas un par envoi.
            boolean fenetre = fenetreVueA != 0 && now - fenetreVueA < 3_000;
            boolean dejaSonne = carillonEnCours() || (dernierCarillon != 0 && now - dernierCarillon < CARILLON_UNE_FOIS_MS);
            if (fenetre || dejaSonne) {
                Log.i(TAG, "Nouvel envoi sans carillon (" + (fenetre ? "fenêtre ouverte" : "déjà sonné") + ")");
                return;
            }
            if (callAudio.busy()) return;
            dernierCarillon = now;
            sonner(1f);
        });
    }

    private boolean carillonEnCours() {
        android.media.MediaPlayer mp = carillon;
        try {
            return mp != null && mp.isPlaying();
        } catch (IllegalStateException e) {
            return false;
        }
    }

    /** Écran allumé et carillon de Papote, à ce volume (1 = volume des médias réglé par la famille). */
    private void sonner(float volume) {
        {
            // Pendant un appel : ni carillon (la famille l'entendrait dans l'appel) ni réveil, l'envoi
            // s'affiche à la fin de l'appel.
            if (callAudio.busy()) return;
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP, "papote:nouveau");
                wl.acquire(15_000);
            } catch (Exception e) {
                Log.w(TAG, "Réveil de l'écran", e);
            }
            // Carillon « ding-dong » de Papote (res/raw/arrivee.wav), au volume des médias réglé par la
            // famille : le petit son de notification de la tablette s'entendait à peine (Tanguy, 26/10).
            try {
                android.media.MediaPlayer mp = android.media.MediaPlayer.create(this, R.raw.arrivee,
                        new android.media.AudioAttributes.Builder()
                                .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build(), 0);
                if (mp != null) {
                    stopCarillon(); // deux envois de suite : un seul carillon à la fois
                    carillon = mp;
                    mp.setOnCompletionListener(m -> { if (carillon == m) carillon = null; m.release(); });
                    mp.setVolume(volume, volume);
                    renfortCarillon.sur(mp);
                    mp.start();
                } else {
                    Ringtone r = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
                    if (r != null) r.play();
                }
            } catch (Exception e) {
                Log.w(TAG, "Son d'arrivée", e);
            }
        }
    }

    private void stopCarillon() {
        android.media.MediaPlayer mp = carillon;
        carillon = null;
        if (mp == null) return;
        try { mp.stop(); } catch (IllegalStateException e) { /* déjà fini */ }
        mp.release();
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
            UserManager.DISALLOW_SAFE_BOOT,
    };

    // ---------- Son et écran : ni réglables ni éteignables par erreur ----------

    /**
     * Volume fort pour la sonnerie et les messages vocaux, ou celui réglé depuis l'app famille
     * (médias, et appels vidéo un peu moins forts que les médias à cause de l'écho).
     */
    private void setVolumes() {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int family = prefs.getInt("volume", -1);
        int media = family < 0 ? 85 : family;
        // Appels (visio et téléphone) au maximum par défaut (Tanguy, 28/10 : la voix du proche restait plus
        // faible que la sonnerie) ; réglables depuis l'app famille (barre « Appels », 29/10).
        int call = prefs.getInt("volumeAppel", 100);
        int[][] levels = {
                {AudioManager.STREAM_MUSIC, media}, {AudioManager.STREAM_RING, prefs.getInt("volumeSonnerie", 100)},
                {AudioManager.STREAM_NOTIFICATION, 90}, {AudioManager.STREAM_VOICE_CALL, Math.min(100, call)},
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
     * La nuit (21h-6h30 par défaut), on le laisse éteint.
     */
    // ---------- Test du son (installation et Réglages de l'app famille) ----------

    // Après un essai, la tablette reprend les volumes enregistrés : un essai suivi d'« Annuler » dans
    // l'app laissait la sonnerie ou les médias au niveau essayé jusqu'au prochain démarrage.
    private boolean essaiSon;
    private final Runnable volumesEnregistres = () -> { essaiSon = false; setVolumes(); };

    private void playSoundTest(String quoi, int volume, String texte) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int v = Math.max(10, Math.min(100, volume));
        essaiSon = true;
        handler.removeCallbacks(volumesEnregistres);
        handler.postDelayed(volumesEnregistres, 12_000);
        try {
            if ("sonnerie".equals(quoi)) {
                am.setStreamVolume(AudioManager.STREAM_RING, am.getStreamMaxVolume(AudioManager.STREAM_RING) * v / 100, 0);
                callAudio.ring(true);
                handler.postDelayed(() -> callAudio.ring(false), 3000);
            } else {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * v / 100, 0);
                speakNow(texte == null || texte.trim().isEmpty() ? "Bonjour, vous m'entendez bien ?" : texte);
            }
        } catch (Exception e) {
            Log.w(TAG, "Test du son", e);
        }
    }

    // ---------- Lecture à voix haute ----------

    private android.speech.tts.TextToSpeech tts;
    private static boolean prechauffeFait;
    private boolean ttsReady;
    private boolean ttsFailed;
    private String ttsPending;
    private boolean ttsPendingGuide;
    private volatile boolean lectureEnCours;

    /**
     * Moteur de voix préparé dès le démarrage : la première lecture part tout de suite (sinon plusieurs
     * secondes d'attente). Une seule voix française installée, nommée, pour le préchargement et la lecture.
     * La page est tenue au courant : « speaking » au début, « done » à la fin (bouton « Écouter »).
     */
    private void prepareTts() {
        if (tts != null) return;
        tts = new android.speech.tts.TextToSpeech(getApplicationContext(), status -> {
            ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS;
            if (!ttsReady) {
                ttsFailed = true;
                Journal.log(this, "Lecture à voix haute indisponible");
                if (ttsPending != null) { ttsPending = null; speechState("done"); }
                return;
            }
            tts.setLanguage(java.util.Locale.FRANCE);
            // Une voix nommée, toujours la même : sinon le moteur Google en prend une pour le
            // préchargement et une autre pour la lecture, qui se charge encore au premier « Écouter ».
            try {
                android.speech.tts.Voice choisie = null;
                for (android.speech.tts.Voice v : tts.getVoices()) {
                    if (!"fr".equals(v.getLocale().getLanguage()) || !"FR".equals(v.getLocale().getCountry())
                            || v.isNetworkConnectionRequired()
                            || v.getFeatures().contains(android.speech.tts.TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    // vlf : la voix française par défaut du moteur. Au démarrage, le moteur charge d'abord
                    // son modèle commun (cfe, ~6 s sur la Vucatimes), puis la voix (~5 s) : ~12 s en tout.
                    if (choisie == null || v.getName().contains("vlf")) choisie = v;
                }
                if (choisie != null) { tts.setVoice(choisie); Journal.log(this, "Voix : " + choisie.getName()); }
            } catch (Exception e) {
                Log.w(TAG, "Voix française", e);
            }
            tts.setSpeechRate(0.85f); // un peu plus lent, plus facile à suivre
            tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override public void onStart(String id) { if (!"prechauffage".equals(id)) speechState("speaking"); }
                @Override public void onDone(String id) { if (!"prechauffage".equals(id)) { lectureEnCours = false; speechState("done"); } }
                @Override public void onError(String id) { if (!"prechauffage".equals(id)) { lectureEnCours = false; speechState("done"); } }
                @Override public void onStop(String id, boolean interrupted) { if (!"prechauffage".equals(id)) { lectureEnCours = false; speechState("done"); } }
            });
            if (ttsPending != null) { String t = ttsPending; ttsPending = null; ttsPendingGuide = false; speakNow(t); }
            else if (!prechauffeFait) {
                // Une seule fois par démarrage de l'app : l'écran peut être recréé (langue, mise à jour)
                // et le « bonjour » tout bas s'entendait deux fois (Tab 60 Pro, 23/10).
                prechauffeFait = true;
                // Le moteur ne charge sa voix (6 à 10 s sur la Vucatimes) qu'à la première phrase dite.
                // Une phrase dite tout bas, par le même chemin que la lecture, la charge d'avance
                // (à volume 0 ou écrite dans un fichier, le moteur charge une autre voix).
                android.os.Bundle bas = new android.os.Bundle();
                bas.putFloat(android.speech.tts.TextToSpeech.Engine.KEY_PARAM_VOLUME, 0.001f); // inaudible, mais prononcée (0,01 s'entendait sur la Tab 60 Pro)
                // Une simple ponctuation : la voix se charge sans qu'aucun mot soit prononcé.
                tts.speak("…", android.speech.tts.TextToSpeech.QUEUE_ADD, bas, "prechauffage");
            }
        });
    }

    private void speechState(String state) {
        try {
            callPage("onSpeech", new JSONObject().put("state", state));
        } catch (Exception ignored) { }
    }

    private void speakNow(String text) {
        if (text == null || text.trim().isEmpty()) return;
        if (ttsFailed) { speechState("done"); return; }
        if (tts == null || !ttsReady) { ttsPending = text; prepareTts(); return; }
        ttsPendingGuide = false;
        lectureEnCours = true;
        tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "papote");
    }

    /** Chargeur branché ou débranché : la famille est prévenue tout de suite (fiche de la tablette). */
    private final android.content.BroadcastReceiver powerChange = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            boolean plugged = Intent.ACTION_POWER_CONNECTED.equals(intent.getAction());
            Journal.log(MainActivity.this, plugged ? "Chargeur branché" : "Chargeur débranché");
            if (sync != null) sync.powerChanged(plugged);
        }
    };

    private final android.content.BroadcastReceiver screenOff = new android.content.BroadcastReceiver() {
        @SuppressWarnings("deprecation")
        @Override
        public void onReceive(Context context, Intent intent) {
            Journal.log(MainActivity.this, "Écran éteint (bouton marche/arrêt ou système)");
            if (kioskPaused() || Veille.isNight(MainActivity.this)) return;
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

    // Tablette en français : menus d'Android et clavier AZERTY. Possible seulement si l'installateur
    // a accordé CHANGE_CONFIGURATION et WRITE_SETTINGS ; sinon rien ne change.
    private void setFrench() {
        if (getResources().getConfiguration().getLocales().get(0).getLanguage().equals("fr")) return;
        if (checkSelfPermission("android.permission.CHANGE_CONFIGURATION") != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "Langue : permission CHANGE_CONFIGURATION absente");
            return;
        }
        try {
            Class.forName("com.android.internal.app.LocalePicker")
                    .getMethod("updateLocales", android.os.LocaleList.class)
                    .invoke(null, new android.os.LocaleList(java.util.Locale.FRANCE));
            Log.i(TAG, "Langue : tablette passée en français");
        } catch (Throwable e) {
            Log.w(TAG, "Langue : passage en français impossible", e);
        }
    }

    private void setupDeviceOwner() {
        setFrench();
        if (!isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        try {
            dpm.setLockTaskPackages(admin, new String[]{getPackageName()});
            // Pas de menu « Éteindre / Redémarrer » sur le bouton marche/arrêt.
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            for (String r : RESTRICTIONS) dpm.addUserRestriction(admin, r);
            // Appels par la carte SIM (chantier téléphone 29/10) : Mamie appelle ses proches par la ligne.
            // Avant, les appels sortants étaient interdits (DISALLOW_OUTGOING_CALLS) : levé sur les tablettes déjà installées.
            dpm.clearUserRestriction(admin, UserManager.DISALLOW_OUTGOING_CALLS);
            Telephone.preparer(this);
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
            hideOtherLaunchers(dpm, admin);
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

    /**
     * Les autres écrans d'accueil sont masqués : la Blackview Tab 60 Pro démarre sur son propre bureau
     * malgré l'accueil imposé et bloque le lancement de Papote au démarrage (1 à 2 min de bureau).
     * Masqué ne veut pas dire effacé : retirer-papote les remet (removeDeviceOwner).
     */
    private void hideOtherLaunchers(DevicePolicyManager dpm, ComponentName admin) {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        java.util.Set<String> hidden = new java.util.HashSet<>(prefs.getStringSet("launchersMasques", new java.util.HashSet<>()));
        for (android.content.pm.ResolveInfo ri : getPackageManager().queryIntentActivities(home, PackageManager.MATCH_ALL)) {
            String pkg = ri.activityInfo.packageName;
            // com.android.settings sert d'accueil de secours à Android : on n'y touche pas.
            if (pkg.equals(getPackageName()) || pkg.equals("com.android.settings")) continue;
            try {
                if (dpm.setApplicationHidden(admin, pkg, true)) {
                    hidden.add(pkg);
                    Journal.log(this, "Écran d'accueil masqué : " + pkg);
                }
            } catch (Exception e) {
                Log.w(TAG, "Masquage de " + pkg, e);
            }
        }
        prefs.edit().putStringSet("launchersMasques", hidden).apply();
    }

    private void removeDeviceOwner() {
        if (!isDeviceOwner()) return;
        DevicePolicyManager dpm = dpm();
        ComponentName admin = admin();
        for (String pkg : prefs.getStringSet("launchersMasques", new java.util.HashSet<>())) {
            try { dpm.setApplicationHidden(admin, pkg, false); } catch (Exception e) { Log.w(TAG, "Démasquage de " + pkg, e); }
        }
        prefs.edit().remove("launchersMasques").apply();
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
        if (kioskPaused() || !isDeviceOwner()) return;
        // Propriétaire de l'appareil devenu pendant que l'app tournait : le kiosque n'était pas configuré.
        if (!dpm().isLockTaskPermitted(getPackageName())) setupDeviceOwner();
        if (!dpm().isLockTaskPermitted(getPackageName())) return;
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
            try { startLockTask(); } catch (Exception e) { Log.w(TAG, "startLockTask", e); }
        }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                // Pas de barre « passagère » : avec la barre d'état désactivée, Android ne la retire
                // jamais (bande grise en haut). Un glissement l'affiche pour de bon, et rehideBars
                // la masque quelques secondes plus tard.
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_BARS_BY_SWIPE);
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
            if (kioskPaused() || Veille.isNight(MainActivity.this)) return;
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
        if (web != null) web.onResume();
        handler.removeCallbacks(rehideBars);
        handler.post(rehideBars);
        enterKiosk();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        handler.removeCallbacks(rehideBars);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (courante == this) courante = null;
        AppelGsm.oublier(this);
        if (tts != null) { try { tts.shutdown(); } catch (Exception ignored) { } }
        try { unregisterReceiver(screenOff); } catch (Exception ignored) { }
        try { unregisterReceiver(powerChange); } catch (Exception ignored) { }
        callAudio.release();
        voicePlayer.stop();
        stopCarillon();
        sync.stop();
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        web = null;
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // Le bouton retour ne fait rien : l'accueil est toujours accessible dans la page.
    }
}
