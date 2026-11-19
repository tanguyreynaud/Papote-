package com.papote.tablette;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Redémarrage à la main (décision de Tanguy, 18/11) : le bouton volume bas tenu 10 s ouvre la fenêtre
 * « Redémarrer la tablette ? » Oui / Non. Oui : la tablette redémarre (jamais d'extinction). Non, ou
 * 1 minute sans réponse (Tanguy, 19/11) : la fenêtre se ferme, comme Non. Rien pendant un appel (visio ou téléphone) ni un SOS. Le
 * volume ne bouge jamais pendant l'appui (MainActivity.dispatchKeyEvent avale déjà les touches).
 *
 * La fenêtre est d'abord celle de la page (tablette.js, style Papote, essayée par android/tests) ; si la
 * page ne dit pas l'avoir affichée dans les 2 s (page figée : c'est justement là qu'on redémarre), la
 * même fenêtre est dessinée ici, par-dessus la page. Chaque geste est noté « GARDE-FOU » au journal.
 * Les décisions sont sans Android, essayées par RedemarrageTest.
 */
final class Redemarrage {
    /** Durée de l'appui sur volume bas. */
    static final long APPUI_MS = 10_000;
    /** Sans réponse, la fenêtre se ferme. */
    static final long REPONSE_MS = 60_000;
    /** La page doit dire qu'elle affiche la fenêtre dans ce délai, sinon la fenêtre de secours s'ouvre. */
    static final long ACCUSE_MS = 2_000;
    /** Laisse le temps à la ligne du journal de partir avant le redémarrage. */
    static final long AVANT_REDEMARRAGE_MS = 1_500;

    static final String TITRE = "Redémarrer la tablette ?";
    static final String DETAIL = "Elle s'éteint puis se rallume toute seule.";
    static final String EN_COURS = "La tablette redémarre…";
    static final String IMPOSSIBLE = "Le redémarrage n'a pas marché.";

    private Redemarrage() { }

    // ---------- Décisions (sans Android) ----------

    /**
     * null si la fenêtre peut s'ouvrir, sinon la raison (pour le journal). sosPage : la page a dit « SOS en
     * cours » (seulement quand ça change) ; pageVivante : la page répond encore (Gardien). Une page figée en
     * plein SOS ne bloque pas le redémarrage : le SOS se reprend au démarrage (A47).
     */
    static String refus(boolean maintenance, boolean appel, boolean appelGsm, boolean sosPage, boolean pageVivante) {
        if (maintenance) return "maintenance";
        if (appel || appelGsm) return "appel en cours";
        if (sosPage && pageVivante) return "SOS en cours";
        return null;
    }

    /** « Oui » n'est valable que pour une fenêtre ouverte par l'appui, et pas après la fermeture automatique. */
    static boolean ouiValable(long demandeA, long maintenant) {
        return demandeA > 0 && maintenant >= demandeA && maintenant - demandeA <= REPONSE_MS + 2_000;
    }

    // ---------- Fenêtre de secours (page figée) ----------

    interface Choix {
        /** Oui : true si le redémarrage est lancé. */
        boolean oui();
        void non();
    }

    /** Même fenêtre que la page : fond crème, Oui en indigo, Non en gris, deux boutons de même taille. */
    static View fenetre(Activity a, Choix choix) {
        FrameLayout voile = new FrameLayout(a);
        voile.setBackgroundColor(Color.argb(140, 28, 25, 23));
        voile.setClickable(true); // rien ne passe à la page dessous
        voile.setElevation(100f);

        Typeface titreTf = police(a, "fonts/bricolage.ttf", Typeface.DEFAULT_BOLD);
        Typeface texteTf = police(a, "fonts/atkinson-400.ttf", Typeface.DEFAULT);
        Typeface boutonTf = police(a, "fonts/atkinson-700.ttf", Typeface.DEFAULT_BOLD);
        int cote = Math.min(a.getResources().getDisplayMetrics().widthPixels, a.getResources().getDisplayMetrics().heightPixels);
        float vmin = cote / 100f;

        LinearLayout carte = new LinearLayout(a);
        carte.setOrientation(LinearLayout.VERTICAL);
        carte.setGravity(Gravity.CENTER_HORIZONTAL);
        carte.setBackground(fond(Color.parseColor("#fdfaf5"), 4 * vmin));
        int pad = Math.round(6 * vmin);
        carte.setPadding(pad, pad, pad, pad);

        TextView titre = texte(a, TITRE, 7 * vmin, titreTf, "#1c1917");
        TextView detail = texte(a, DETAIL, 4.5f * vmin, texteTf, "#44403c");
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dlp.topMargin = Math.round(2 * vmin);
        carte.addView(titre);
        carte.addView(detail, dlp);

        LinearLayout boutons = new LinearLayout(a);
        boutons.setOrientation(LinearLayout.HORIZONTAL);
        Button oui = bouton(a, "Oui", "#4f46e5", boutonTf, vmin);
        Button non = bouton(a, "Non", "#57534e", boutonTf, vmin);
        int largeur = Math.round(30 * vmin), hauteur = Math.round(14 * vmin);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(largeur, hauteur);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(largeur, hauteur);
        nlp.leftMargin = Math.round(5 * vmin);
        boutons.addView(oui, olp);
        boutons.addView(non, nlp);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.topMargin = Math.round(5 * vmin);
        carte.addView(boutons, blp);

        // Un seul appel même si le doigt touche deux fois : les deux boutons sont coupés au premier toucher.
        oui.setOnClickListener(v -> {
            oui.setEnabled(false);
            non.setEnabled(false);
            titre.setText(EN_COURS);
            detail.setText(DETAIL);
            if (!choix.oui()) {
                titre.setText(IMPOSSIBLE);
                detail.setText("");
            }
        });
        non.setOnClickListener(v -> {
            oui.setEnabled(false);
            non.setEnabled(false);
            choix.non();
        });

        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.gravity = Gravity.CENTER;
        voile.addView(carte, clp);
        return voile;
    }

    private static Typeface police(Activity a, String chemin, Typeface defaut) {
        try {
            return Typeface.createFromAsset(a.getAssets(), chemin);
        } catch (Exception e) {
            return defaut;
        }
    }

    private static GradientDrawable fond(int couleur, float rayon) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(couleur);
        d.setCornerRadius(rayon);
        return d;
    }

    private static TextView texte(Activity a, String s, float px, Typeface tf, String couleur) {
        TextView t = new TextView(a);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_PX, px);
        t.setTypeface(tf);
        t.setTextColor(Color.parseColor(couleur));
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private static Button bouton(Activity a, String s, String couleur, Typeface tf, float vmin) {
        Button b = new Button(a);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_PX, 6 * vmin);
        b.setTypeface(tf);
        b.setTextColor(Color.WHITE);
        b.setBackground(fond(Color.parseColor(couleur), 3 * vmin));
        b.setStateListAnimator(null);
        b.setSingleLine(true);
        return b;
    }
}
