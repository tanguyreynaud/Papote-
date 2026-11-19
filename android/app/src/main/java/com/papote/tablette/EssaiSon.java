package com.papote.tablette;

/**
 * Essais du son demandés par l'app famille (« Écouter » dans Réglages > Volumes, et à l'installation) :
 * « sonnerie » (3 s de la sonnerie d'appel), « voix » (une phrase au volume des vidéos et messages lus),
 * « appel » (une phrase au volume des appels).
 *
 * Un seul son à la fois (Tanguy, 19/11) : chaque essai coupe celui en cours avant de jouer. Avant, une
 * sonnerie d'essai continuait sous la voix de l'essai suivant, et la fin programmée d'une ancienne sonnerie
 * coupait la nouvelle en plein milieu. Sans Android : MainActivity fournit la sortie, EssaiSonTest une fausse.
 */
final class EssaiSon {
    static final long SONNERIE_MS = 3_000;
    static final String PHRASE = "Bonjour, vous m'entendez bien ?";

    /** Ce que la tablette sait faire (fil principal). */
    interface Sortie {
        /** Volume du flux de l'essai : sonnerie, ou médias pour « voix » et « appel ». */
        void volume(String quoi, int pourcent);
        void sonnerie(boolean on);
        void parler(String texte);
        /** Coupe la voix en cours (essai ou lecture d'un message). */
        void taire();
        void plusTard(Runnable r, long ms);
        void annuler(Runnable r);
    }

    private final Sortie sortie;
    private boolean sonnerieEnCours;
    private final Runnable finSonnerie = this::arreterSonnerie;

    EssaiSon(Sortie sortie) {
        this.sortie = sortie;
    }

    /** « sonnerie », « appel » ou « voix » (tout le reste, comme les tablettes d'avant). */
    static String quoi(String quoi) {
        return "sonnerie".equals(quoi) || "appel".equals(quoi) ? quoi : "voix";
    }

    /** Jamais sous 10 % : la tablette doit toujours s'entendre. */
    static int niveau(int volume) {
        return Math.max(10, Math.min(100, volume));
    }

    void jouer(String quoi, int volume, String texte) {
        couper();
        String q = quoi(quoi);
        sortie.volume(q, niveau(volume));
        if ("sonnerie".equals(q)) {
            sonnerieEnCours = true;
            sortie.sonnerie(true);
            sortie.plusTard(finSonnerie, SONNERIE_MS);
        } else {
            sortie.parler(texte == null || texte.trim().isEmpty() ? PHRASE : texte);
        }
    }

    /** Coupe l'essai en cours : sonnerie d'essai et voix. */
    void couper() {
        arreterSonnerie();
        sortie.taire();
    }

    /**
     * Un vrai appel sonne : la sonnerie d'essai devient la sienne, sa fin programmée ne doit pas la couper
     * (CallAudio.ring ne relance pas une sonnerie qui joue déjà).
     */
    void appelReel() {
        sortie.annuler(finSonnerie);
        sonnerieEnCours = false;
    }

    private void arreterSonnerie() {
        sortie.annuler(finSonnerie);
        if (!sonnerieEnCours) return;
        sonnerieEnCours = false;
        sortie.sonnerie(false);
    }
}
