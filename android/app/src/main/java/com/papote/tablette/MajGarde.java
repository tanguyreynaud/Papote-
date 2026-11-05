package com.papote.tablette;

import java.util.regex.Pattern;

/**
 * Garde-fous de la mise à jour à distance (audit reprise après sinistre, 5/11, scénario « dépôt GitHub ou
 * hébergement Firebase compromis »). Android refuse déjà tout APK qui n'est pas signé par la clé de Papote
 * (Updater.install, même paquet) : un attaquant qui modifie version.json ne peut PAS installer son appli.
 * Il peut en revanche faire télécharger n'importe quoi, sans fin, sur la SIM prépayée de chaque tablette
 * (empreinte fausse → nouvel essai à chaque vérification et à chaque annonce). D'où :
 *   - adresse de l'APK limitée au dépôt Papote sur GitHub, à un commit précis (ce qu'écrit maj-commun.ps1) ;
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
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");

    private MajGarde() { }

    /** null si l'entrée de version.json est acceptable, sinon la raison du refus (pour le journal). */
    static String refus(String url, String sha256, String empreinteDejaRefusee) {
        if (url == null || !URL_APK.matcher(url).matches()) return "adresse d'APK inattendue : " + url;
        if (sha256 == null || !SHA256.matcher(sha256).matches()) return "empreinte absente ou mal formée";
        if (sha256.equalsIgnoreCase(empreinteDejaRefusee)) return "empreinte déjà refusée, pas de nouveau téléchargement";
        return null;
    }
}
