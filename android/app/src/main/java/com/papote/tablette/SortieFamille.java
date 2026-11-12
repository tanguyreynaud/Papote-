package com.papote.tablette;

/**
 * La tablette doit-elle oublier sa famille ? (audit réseau du 11/11)
 *
 * Avant : un seul refus du serveur (HTTP 403) sur la fiche de la tablette suffisait, et la tablette oubliait
 * sa famille, effaçait ses photos et revenait à l'écran du code. Or un 403 arrive aussi quand la tablette
 * est toujours dans sa famille : règles publiées avec une erreur, App Check exigé alors que le jeton manque,
 * facturation Google coupée (coupe-circuit), clé Firebase restreinte. Toutes les tablettes seraient alors
 * sorties de leur famille en même temps, sans retour possible à distance.
 *
 * Maintenant, la tablette ne sort que si :
 *   - sa fiche est refusée ou absente (403, 404) ALORS QU'une lecture témoin ouverte à tout compte connecté
 *     (config/base) répond normalement : le serveur marche, c'est bien la fiche qui a disparu ;
 *   - et cela se répète sur plusieurs tours pendant un quart d'heure (sauf pendant une installation, où
 *     « Recommencer » sur le téléphone doit ramener l'écran du code tout de suite, et où il n'y a rien à perdre).
 * Sans Android : essayé par SortieFamilleTest (gradlew test).
 */
final class SortieFamille {
    static final int DOUTES_MIN = 3;
    static final long DUREE_MIN_MS = 15 * 60_000L;

    private SortieFamille() { }

    /**
     * La fiche a-t-elle vraiment disparu ? codeFiche et codeTemoin : codes HTTP des deux lectures
     * (200 lu, 404 absent, 403 refusé, 0 erreur de réseau…).
     */
    static boolean ficheDisparue(int codeFiche, int codeTemoin) {
        boolean ficheAbsente = codeFiche == 403 || codeFiche == 404;
        boolean serveurRepond = codeTemoin == 200 || codeTemoin == 404;
        return ficheAbsente && serveurRepond;
    }

    /** Faut-il quitter la famille maintenant, après ce nombre de constats d'affilée étalés sur cette durée ? */
    static boolean quitter(int doutes, long depuisMs, boolean installation) {
        if (doutes < 1) return false;
        if (installation) return true;
        return doutes >= DOUTES_MIN && depuisMs >= DUREE_MIN_MS;
    }
}
