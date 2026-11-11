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
     * Android a-t-il refusé l'APK pour une raison qui ne changera pas en réessayant ? (PackageInstaller :
     * 4 fichier invalide, 5 conflit avec l'appli installée dont la signature, 7 incompatible avec la tablette.)
     * Les autres échecs (place manquante, installation interrompue) sont passagers : nouvel essai le lendemain.
     */
    static boolean refusDefinitif(int statut) {
        return statut == 4 || statut == 5 || statut == 7;
    }
}
