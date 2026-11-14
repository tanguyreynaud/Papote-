package com.papote.tablette;

import java.util.Set;

/**
 * Changer le wifi depuis l'appli famille (audit réseau du 11/11, RM6 ; A36, décision de Tanguy du 12/11) :
 * « il faut que ça déconnecte que si on est connecté à un nouveau wifi et ça déconnecte mais ça n'oublie pas ».
 *
 * La tablette ne quitte son wifi que si le nouveau marche (internet vérifié par Android, en 60 s au plus) ;
 * sinon elle revient sur l'ancien. Elle n'oublie jamais un réseau déjà enregistré : après un échec, seul le
 * réseau ajouté pour l'essai est retiré. La famille lit un vrai résultat (issue + texte), jamais
 * « La tablette se connecte » sans vérification. Partie Android : Wifi.changer ; ici, les décisions, sans
 * Android (WifiChangementTest).
 */
final class WifiChangement {
    enum Issue {
        CONNECTEE("connectee"), DEJA("deja"), MOT_DE_PASSE("mot-de-passe"), INTROUVABLE("introuvable"),
        SANS_INTERNET("sans-internet"), ECHEC("echec");

        /** Valeur écrite dans l'ordre (commands/{id}.issue), lue par l'appli famille. */
        final String code;

        Issue(String code) { this.code = code; }
    }

    /** Délai laissé au nouveau réseau pour donner internet. */
    static final long ATTENTE_MS = 60_000;
    /** Délai laissé à l'ancien réseau pour revenir après un échec. */
    static final long RETOUR_MS = 30_000;

    private WifiChangement() { }

    /**
     * Résultat d'un essai. vu : le réseau est dans la recherche ; authRefusee : Android a signalé une erreur
     * d'authentification (mot de passe) ; associe : la tablette s'y est accrochée ; internet : validé par Android.
     */
    static Issue issue(boolean vu, boolean authRefusee, boolean associe, boolean internet) {
        if (internet) return Issue.CONNECTEE;
        if (!vu) return Issue.INTROUVABLE;
        if (authRefusee) return Issue.MOT_DE_PASSE;
        if (associe) return Issue.SANS_INTERNET;
        return Issue.ECHEC;
    }

    /** Après un échec, retirer le réseau essayé ? Seulement s'il n'était pas déjà enregistré avant. */
    static boolean retirerApresEchec(int idEssaye, Set<Integer> enregistresAvant) {
        return idEssaye >= 0 && !enregistresAvant.contains(idEssaye);
    }

    /** Où la tablette est restée : « « Livebox » », « la carte SIM », ou rien. */
    static String restee(String ancien, boolean mobile) {
        if (ancien != null && !ancien.isEmpty()) return "« " + ancien + " »";
        return mobile ? "la carte SIM" : "";
    }

    /** Texte montré à la famille (dans l'appli) et noté au journal. */
    static String texte(Issue issue, String ssid, String ancien, boolean mobile) {
        String r = restee(ancien, mobile);
        String suite = r.isEmpty() ? "" : " La tablette est restée sur " + r + ".";
        switch (issue) {
            case CONNECTEE:
                return "Connectée à « " + ssid + " »."
                        + (ancien == null || ancien.isEmpty() || ancien.equals(ssid) ? "" : " L'ancien wifi « " + ancien + " » reste enregistré.");
            case DEJA:
                return "La tablette est déjà connectée à « " + ssid + " ».";
            case MOT_DE_PASSE:
                return "Mot de passe refusé par « " + ssid + " »." + suite;
            case INTROUVABLE:
                return "Réseau « " + ssid + " » introuvable autour de la tablette." + suite;
            case SANS_INTERNET:
                return "« " + ssid + " » accepte la tablette mais ne donne pas internet." + suite;
            default:
                return "La tablette n'a pas pu se connecter à « " + ssid + " » (mot de passe ou signal trop faible)." + suite;
        }
    }

    static boolean reussi(Issue issue) {
        return issue == Issue.CONNECTEE || issue == Issue.DEJA;
    }
}
