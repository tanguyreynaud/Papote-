package fr.mapapote.famille;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import android.view.View;
import android.webkit.WebView;
import android.widget.TextView;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import java.lang.reflect.Method;
import java.time.Duration;

/**
 * Appel lancé depuis le téléphone (13/11, Tanguy : « ça met Papote avec un chargement, c'est hyper
 * moche ») : l'écran d'appel natif s'affiche tout de suite, la page le remplace quand elle est prête.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class AttenteAppelTest {
    private Application ctx;

    @Before
    public void preparer() {
        ctx = RuntimeEnvironment.getApplication();
    }

    private ActivityController<AppelEnCours> ouvrir() {
        Intent i = AppelEnCours.pour(ctx, "/?appeler=video&famille=f1", "jeton");
        return Robolectric.buildActivity(AppelEnCours.class, i).setup();
    }

    private static WebView page(AppelEnCours a) {
        return findWebView(a.getWindow().getDecorView());
    }

    private static WebView findWebView(View v) {
        if (v instanceof WebView) return (WebView) v;
        if (v instanceof android.view.ViewGroup) {
            android.view.ViewGroup g = (android.view.ViewGroup) v;
            for (int k = 0; k < g.getChildCount(); k++) {
                WebView w = findWebView(g.getChildAt(k));
                if (w != null) return w;
            }
        }
        return null;
    }

    /** Ce que fait la page quand son écran d'appel est affiché : PapoteNatif.etat(...). */
    private static void pageEnvoie(WebView w, String etat, String nom) throws Exception {
        Object pont = shadowOf(w).getJavascriptInterface("PapoteNatif");
        Method m = pont.getClass().getMethod("etat", String.class, String.class, boolean.class);
        m.setAccessible(true);
        m.invoke(pont, etat, nom, true);
        shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
    }

    private static String texte(AppelEnCours a, int id) {
        return ((TextView) a.findViewById(id)).getText().toString();
    }

    @Test
    public void lEcranDAppelEstLaDesLeToucherAvecLeNomConnu() {
        Raccourci.nommer(ctx, "Mamie Emma");
        AppelEnCours a = ouvrir().get();
        assertTrue("écran d'appel natif tout de suite", a.attenteVisible());
        assertEquals("Mamie Emma", texte(a, R.id.attente_nom));
        assertEquals("M", texte(a, R.id.attente_initiale));
        assertEquals("Connexion…", ((TextView) ((android.view.ViewGroup) a.findViewById(R.id.attente)).getChildAt(3)).getText().toString());
        assertTrue("la page se charge derrière", shadowOf(page(a)).getLastLoadedUrl().startsWith("https://app.mapapote.fr/?appeler=video"));
    }

    @Test
    public void sansNomEncoreConnuOnNeMontrePasDeVide() {
        AppelEnCours a = ouvrir().get();
        assertEquals("La tablette", texte(a, R.id.attente_nom));
        assertEquals("L", texte(a, R.id.attente_initiale));
    }

    @Test
    public void laPagePretePrendLaPlaceEtLeNomEstRetenu() throws Exception {
        AppelEnCours a = ouvrir().get();
        pageEnvoie(page(a), "connexion", "Mamie Jeanne");
        assertFalse("écran natif effacé, la page montre le même", a.attenteVisible());
        assertEquals("prochain appel : bon nom dès le début", "Mamie Jeanne", Raccourci.nomConnu(ctx));
        // Les états suivants ne le refont pas apparaître.
        pageEnvoie(page(a), "en_cours", "Mamie Jeanne");
        assertFalse(a.attenteVisible());
    }

    @Test
    public void raccrocherPendantLeChargementFermeToutDeSuite() {
        AppelEnCours a = ouvrir().get();
        a.findViewById(R.id.attente_raccrocher).performClick();
        assertTrue(a.isFinishing());
    }

    @Test
    public void doubleToucherSurRaccrocherSansErreur() {
        AppelEnCours a = ouvrir().get();
        View b = a.findViewById(R.id.attente_raccrocher);
        b.performClick();
        b.performClick();
        assertTrue(a.isFinishing());
    }

    @Test
    public void pageQuiNeRepondPasOnLaMontreApres20s() {
        AppelEnCours a = ouvrir().get();
        shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofMillis(AppelEnCours.ATTENTE_MAX_MS - 1000));
        assertTrue("encore l'écran d'appel pendant le chargement normal", a.attenteVisible());
        shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertFalse("puis la page (son écran « Pas d'internet » par exemple)", a.attenteVisible());
    }

    @Test
    public void unLienSansLaCleNOuvreRien() {
        Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("papote://appel?u=/%3Fappeler%3Dvideo"));
        AppelEnCours a = Robolectric.buildActivity(AppelEnCours.class, i).setup().get();
        assertTrue(a.isFinishing());
    }
}
