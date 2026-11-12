package com.papote.tablette;

import java.util.regex.Pattern;

/**
 * Garde-fous de la mise à jour à distance (audit reprise après sinistre, 5/11, scénario « dépôt GitHub ou
 * hébergement Firebase compromis »). Android refuse déjà tout APK qui n'est pas signé par la clé de Papote
 * (Updater.install, même paquet) : un attaquant qui modifie version.json ne peut PAS installer son appli.
 * Il peut en revanche faire télécharger n'importe quoi, sans fin, sur la SIM prépayée de chaque tablette
 * (empreinte fausse → nouvel essai à chaque vérification et à chaque annonce). D'où :
 *   - adresse de l'APK limitée au dépôt Papote sur GitHub, à un commit précis (ce qu'écrit maj-commun.ps1),
 *     ou au domaine de Papote maj.mapapote.fr (secours si le dépôt GitHub est perdu, DNS chez OVH) ;
 *   - taille plafonnée (l'APK fait ~4 Mo en novembre 2026) ;
 *   - une empreinte déjà refusée n'est plus jamais retéléchargée.
 * Sans Android : essayé par MajGardeTest (gradlew test).
 */
final class MajGarde {
    /** Plafond de téléchargement : ~7 fois la taille actuelle de l'APK (3,3 à 4 Mo). */
    static final long TAILLE_MAX = 30L * 1024 * 1024;

    /** https://raw.githubusercontent.com/tanguyreynaud/Papote-/<sha1 du commit>/installation/Papote(-test).apk */
    private static final Pattern URL_APK = Pattern.compile(
            "^https://raw\\.githubusercontent\\.com/tanguyreynaud/Papote-/[0-9a-f]{40}/installation/Papote(-test)?\\.apk$");
    /** Secours : https://maj.mapapote.fr/<nom>.apk (hébergement choisi par Tanguy si GitHub n'est plus utilisable). */
    private static final Pattern URL_APK_SECOURS = Pattern.compile("^https://maj\\.mapapote\\.fr/[A-Za-z0-9._-]{1,80}\\.apk$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");

    private MajGarde() { }

    /** null si l'entrée de version.json est acceptable, sinon la raison du refus (pour le journal). */
    static String refus(String url, String sha256, String empreinteDejaRefusee) {
        if (url == null || !(URL_APK.matcher(url).matches() || URL_APK_SECOURS.matcher(url).matches())) return "adresse d'APK inattendue : " + url;
        if (sha256 == null || !SHA256.matcher(sha256).matches()) return "empreinte absente ou mal formée";
        if (sha256.equalsIgnoreCase(empreinteDejaRefusee)) return "empreinte déjà refusée, pas de nouveau téléchargement";
        return null;
    }

    /**
     * Parmi plusieurs fichiers de version, l'indice du plus récent qui est acceptable ; si aucun ne l'est,
     * l'indice du plus récent tout court. Tableaux de même longueur, au moins un élément.
     */
    static int choisir(int[] codes, boolean[] acceptables) {
        int meilleur = -1, recent = 0;
        for (int i = 0; i < codes.length; i++) {
            if (codes[i] > codes[recent]) recent = i;
            if (acceptables[i] && (meilleur < 0 || codes[i] > codes[meilleur])) meilleur = i;
        }
        return meilleur >= 0 ? meilleur : recent;
    }

    /**
     * Attente avant un nouvel essai après ce nombre d'échecs d'affilée (fichier de version injoignable,
     * téléchargement de l'APK coupé) : 10 min, 30 min, 2 h, 6 h, puis une fois par jour. Avant (audit réseau
     * du 11/11) : toutes les 10 min sans fin, et l'APK entier (4 Mo) repris de zéro à chaque fois, soit
     * jusqu'à plusieurs centaines de Mo par jour sur une carte SIM qui capte mal.
     */
    static long attenteApresEchec(int echecs) {
        if (echecs <= 1) return 10 * 60_000L;
        if (echecs == 2) return 30 * 60_000L;
        if (echecs == 3) return 2 * 3600_000L;
        if (echecs == 4) return 6 * 3600_000L;
        return 24 * 3600_000L;
    }

    /** Installations ratées d'affilée du même APK (place manquante, vérification d'Android) avant d'abandonner. */
    static final int ESSAIS_INSTALLATION = 3;

    /**
     * Un refus « passager » d'Android qui se répète n'est plus passager : au bout de 3 installations ratées,
     * cet APK n'est plus retéléchargé (4 Mo à chaque démarrage et chaque jour, sans fin, sur la carte SIM).
     * Une nouvelle publication (autre empreinte) repart de zéro.
     */
    static boolean abandonner(int installationsRatees) {
        return installationsRatees >= ESSAIS_INSTALLATION;
    }

    /** Compteur gardé sous la forme « empreinte:nombre » : le nombre pour cette empreinte, 0 pour une autre. */
    static int essaisPour(String compteur, String sha256) {
        if (compteur == null || sha256 == null) return 0;
        int i = compteur.lastIndexOf(':');
        if (i <= 0 || !compteur.substring(0, i).equalsIgnoreCase(sha256)) return 0;
        try {
            return Math.max(0, Integer.parseInt(compteur.substring(i + 1)));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Android a-t-il refusé l'APK pour une raison qui ne changera pas en réessayant ? (PackageInstaller :
     * 4 fichier invalide, 5 conflit avec l'appli installée dont la signature, 7 incompatible avec la tablette.)
     * Les autres échecs (place manquante, installation interrompue) sont passagers : nouvel essai le lendemain.
     */
    static boolean refusDefinitif(int statut) {
        return statut == 4 || statut == 5 || statut == 7;
    }
}
