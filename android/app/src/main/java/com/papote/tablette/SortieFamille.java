package com.papote.tablette;

/**
 * La tablette doit-elle oublier sa famille ? (audit réseau du 11/11, puis décision de Tanguy du 12/11, A30)
 *
 * Oublier sa famille efface les photos, les vidéos et les numéros du SOS, et il faut ensuite quelqu'un chez la
 * personne pour relier la tablette de nouveau. Or un refus du serveur (HTTP 403, 404) arrive aussi quand la
 * tablette est toujours dans sa famille : base vidée ou restaurée par erreur, règles publiées avec une erreur,
 * App Check exigé sans jeton, facturation Google coupée, clé Firebase restreinte. Toutes les tablettes
 * partiraient alors en même temps.
 *
 * Règle (Tanguy, 12/11) :
 *   - la tablette n'oublie sa famille qu'après 72 heures de refus continu : sa fiche refusée ou absente ALORS
 *     QU'une lecture témoin ouverte à tout compte connecté (config/base) répond (le serveur marche, c'est bien
 *     la fiche qui a disparu) ;
 *   - l'absence de réseau ne compte JAMAIS comme un refus : ni le temps passé sans réseau (ou tablette éteinte,
 *     ou serveur qui refuse tout, témoin compris), ni comme une remise à zéro ;
 *   - le compteur repart de zéro dès qu'une lecture réussit (famille ou fiche lue) ;
 *   - il est gardé sur la tablette (Sync.java : réglages enregistrés) et survit à un redémarrage ;
 *   - restent immédiats : l'annulation pendant l'installation (« Recommencer » côté serveur, rien à perdre) et
 *     les ordres clairs de l'admin (« verrouiller », « usine » : Sync.runCommands, hors de ce compteur).
 * Pendant ces 72 heures, la tablette garde ses photos, ses numéros SOS et l'accueil normal.
 * Sans Android : essayé par SortieFamilleTest (gradlew test).
 */
final class SortieFamille {
    /** Refus continu au bout duquel la tablette oublie sa famille. */
    static final long DELAI_MS = 72 * 3600_000L;
    /**
     * Deux refus plus espacés que cela ne se suivent pas (tablette éteinte, tour manqué) : l'intervalle ne compte
     * pas. Les tours normaux sont toutes les 30 min le jour, 60 min la nuit.
     */
    static final long ECART_MAX_MS = 3 * 3600_000L;

    /** Ce qu'a donné une vérification. */
    enum Constat { LUE, REFUS, INCERTAIN }

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

    /** Fiche lue : la tablette est dans sa famille. Fiche disparue : un refus. Tout le reste : on ne sait pas. */
    static Constat constat(int codeFiche, int codeTemoin) {
        if (codeFiche == 200) return Constat.LUE;
        return ficheDisparue(codeFiche, codeTemoin) ? Constat.REFUS : Constat.INCERTAIN;
    }

    /**
     * Compteur du refus continu : durée de refus déjà vue (cumulMs) et heure du dernier refus (dernierRefus,
     * 0 = la série est interrompue : le prochain refus ne compte pas le temps écoulé depuis).
     */
    static final class Compteur {
        long cumulMs;
        long dernierRefus;

        Compteur(long cumulMs, long dernierRefus) {
            this.cumulMs = Math.max(0, cumulMs);
            this.dernierRefus = Math.max(0, dernierRefus);
        }

        /** Un refus constaté à cette heure : le temps depuis le refus précédent compte, s'il le suit de près. */
        void refus(long maintenant) {
            if (dernierRefus > 0) {
                long ecart = maintenant - dernierRefus;
                // Horloge remise en arrière ou trou trop long (éteinte, sans réseau) : on ne compte pas.
                if (ecart > 0 && ecart <= ECART_MAX_MS) cumulMs += ecart;
            }
            dernierRefus = maintenant;
        }

        /** Pas de réseau, ou le serveur refuse tout : rien ne compte, rien ne s'efface. */
        void incertain() {
            dernierRefus = 0;
        }

        /** Une lecture a réussi : tout repart de zéro. */
        void lue() {
            cumulMs = 0;
            dernierRefus = 0;
        }

        boolean vide() {
            return cumulMs == 0 && dernierRefus == 0;
        }

        /** Clés des réglages de la tablette (SharedPreferences) où le compteur est gardé. */
        static final String CLE_CUMUL = "sortieCumul";
        static final String CLE_DERNIER = "sortieDernier";

        /** Relit le compteur gardé (après un redémarrage, par exemple). Clé absente : 0. */
        static Compteur relire(java.util.function.ToLongFunction<String> lire) {
            return new Compteur(lire.applyAsLong(CLE_CUMUL), lire.applyAsLong(CLE_DERNIER));
        }

        /** Garde le compteur ; null pour une clé à effacer (compteur à zéro). */
        void garder(java.util.function.BiConsumer<String, Long> ecrire) {
            ecrire.accept(CLE_CUMUL, vide() ? null : cumulMs);
            ecrire.accept(CLE_DERNIER, vide() ? null : dernierRefus);
        }

        void noter(Constat c, long maintenant) {
            if (c == Constat.LUE) lue();
            else if (c == Constat.REFUS) refus(maintenant);
            else incertain();
        }
    }

    /** Faut-il quitter la famille maintenant ? refusMaintenant : le constat qui vient d'être fait est un refus. */
    static boolean quitter(Compteur c, boolean refusMaintenant, boolean installation) {
        if (!refusMaintenant) return false;
        if (installation) return true; // annulation pendant l'installation : l'écran d'attente revient tout de suite
        return c.cumulMs >= DELAI_MS;
    }
}
