package fr.mapapote.famille;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * L'appel lui-même, dans l'app : la page d'appel de l'app famille (app.mapapote.fr) dans une
 * WebView à nous, et non dans Chrome. Avec le service {@link AppelService} (notification
 * « Appel en cours » dans la barre, comme WhatsApp), Android laisse le micro et la caméra
 * allumés quand on passe à une autre app : dans Chrome, il coupait le micro.
 *
 * La page se connecte au compte du proche avec le jeton reçu du serveur (#connexion=…, voir
 * functions/appels.js) et prévient l'app par window.PapoteNatif : etat(etat, nom, video), fin().
 * L'app raccroche par window.papoteRaccrocher().
 */
public class AppelEnCours extends Activity {
    static final String ACTION_RACCROCHER = "fr.mapapote.famille.RACCROCHER";
    private static final String EXTRA_URL = "url";
    private static final String HOTE = "app.mapapote.fr";
    private static final int DEMANDE_MICRO = 7;

    private WebView page;
    private PermissionRequest enAttente;
    private boolean fini;

    private final BroadcastReceiver raccrocher = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            page.evaluateJavascript("window.papoteRaccrocher && window.papoteRaccrocher()", null);
        }
    };

    /** Répondre à la tablette : la page décroche toute seule (?appel=…). */
    static Intent pourRepondre(Context ctx, String cid) {
        return pour(ctx, "/?appel=" + Uri.encode(cid), Appels.connexion(ctx, cid));
    }

    static Intent pour(Context ctx, String chemin, String connexion) {
        String url = "https://" + HOTE + chemin + (connexion != null ? "#connexion=" + Uri.encode(connexion) : "");
        return new Intent(ctx, AppelEnCours.class)
                .putExtra(EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        page = new WebView(this);
        setContentView(page);
        WebSettings r = page.getSettings();
        r.setJavaScriptEnabled(true);
        r.setDomStorageEnabled(true);
        r.setMediaPlaybackRequiresUserGesture(false);
        r.setUserAgentString(r.getUserAgentString() + " PapoteNatif");
        CookieManager.getInstance().setAcceptCookie(true);
        page.addJavascriptInterface(new Pont(), "PapoteNatif");
        page.setWebViewClient(new WebViewClient() {
            // Liens vers un autre site (aide, paiement…) : dans le navigateur, pas dans l'appel.
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOTE.equals(u.getHost()) || String.valueOf(u.getHost()).endsWith("firebaseapp.com")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception e) {
                    // aucune app pour ce lien
                }
                return true;
            }
        });
        page.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest demande) {
                runOnUiThread(() -> autoriser(demande));
            }
        });
        ContextCompat.registerReceiver(this, raccrocher, new IntentFilter(ACTION_RACCROCHER),
                ContextCompat.RECEIVER_NOT_EXPORTED);
        // Retour : l'appel continue, on revient simplement à l'écran précédent.
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> moveTaskToBack(true));
        }
        charger(getIntent());
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Touché sur la notification « Appel en cours » : on revient à l'appel, sans recharger.
        if (intent.getStringExtra(EXTRA_URL) != null || intent.getData() != null) {
            setIntent(intent);
            charger(intent);
        }
    }

    private void charger(Intent intent) {
        String url = intent.getStringExtra(EXTRA_URL);
        // Lancé depuis l'app famille (bouton d'appel) : papote://appel?u=/chemin&connexion=jeton
        Uri lien = intent.getData();
        if (url == null && lien != null && "papote".equals(lien.getScheme()) && "appel".equals(lien.getHost())) {
            String chemin = lien.getQueryParameter("u");
            if (chemin != null && chemin.startsWith("/") && !chemin.startsWith("//")) {
                url = pour(this, chemin, lien.getQueryParameter("connexion")).getStringExtra(EXTRA_URL);
            }
        }
        Uri u = url != null ? Uri.parse(url) : null;
        if (u == null || !HOTE.equals(u.getHost())) {
            finish();
            return;
        }
        fini = false;
        page.loadUrl(url);
    }

    // La page demande le micro (et la caméra en vidéo) : autorisation Android d'abord si besoin.
    private void autoriser(PermissionRequest demande) {
        List<String> manque = new ArrayList<>();
        for (String res : demande.getResources()) {
            String perm = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res) ? Manifest.permission.RECORD_AUDIO
                    : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res) ? Manifest.permission.CAMERA : null;
            if (perm != null && checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) manque.add(perm);
        }
        if (manque.isEmpty()) {
            demande.grant(demande.getResources());
            return;
        }
        if (enAttente != null) enAttente.deny();
        enAttente = demande;
        requestPermissions(manque.toArray(new String[0]), DEMANDE_MICRO);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] resultats) {
        super.onRequestPermissionsResult(code, perms, resultats);
        if (code != DEMANDE_MICRO || enAttente == null) return;
        PermissionRequest demande = enAttente;
        enAttente = null;
        List<String> ok = new ArrayList<>();
        for (String res : demande.getResources()) {
            String perm = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res) ? Manifest.permission.RECORD_AUDIO
                    : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res) ? Manifest.permission.CAMERA : null;
            if (perm == null || checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) ok.add(res);
        }
        if (ok.isEmpty()) demande.deny();
        else demande.grant(ok.toArray(new String[0]));
    }

    private void terminer() {
        if (fini) return;
        fini = true;
        AppelService.arreter(this);
        finishAndRemoveTask();
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(raccrocher);
        AppelService.arreter(this);
        page.destroy();
        super.onDestroy();
    }

    /** Appelé par la page (window.PapoteNatif). */
    private class Pont {
        /** etat : 'connexion' | 'sonne' | 'en_cours' ; nom : la personne en face ; video : caméra allumée. */
        @JavascriptInterface
        public void etat(String etat, String nom, boolean video) {
            runOnUiThread(() -> {
                if (!fini) AppelService.montrer(AppelEnCours.this, etat, nom, video);
            });
        }

        /** L'appel est fini (ou l'écran d'appel quitté) : la notification disparaît, l'écran se ferme. */
        @JavascriptInterface
        public void fin() {
            runOnUiThread(AppelEnCours.this::terminer);
        }
    }
}
