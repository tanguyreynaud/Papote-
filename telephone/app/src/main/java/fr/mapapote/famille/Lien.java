package fr.mapapote.famille;

import android.content.Context;
import android.net.Uri;

import java.security.SecureRandom;

/**
 * Clé secrète de ce téléphone pour les liens papote://appel et papote://quitter (audit A2, 11/11).
 *
 * Ces écrans sont ouvrables par un lien, donc par n'importe quelle page web : un lien piégé pouvait
 * connecter l'écran d'appel au compte d'un autre et lancer un appel vidéo. L'app donne cette clé à
 * l'app famille au lancement (?cle=, voir Ouverture) ; la page la remet dans ses liens. Sans la bonne
 * clé, le lien ne fait rien. Tirée au hasard une fois par installation, jamais envoyée ailleurs.
 */
final class Lien {
    private Lien() {}

    private static final String PREFS = "lien";
    private static final String CLE = "cle";
    static final String EXTRA_CLE = "cle";

    static synchronized String cle(Context ctx) {
        String c = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CLE, null);
        if (c == null) {
            byte[] octets = new byte[16];
            new SecureRandom().nextBytes(octets);
            StringBuilder s = new StringBuilder();
            for (byte b : octets) s.append(String.format(java.util.Locale.ROOT, "%02x", b));
            c = s.toString();
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(CLE, c).apply();
        }
        return c;
    }

    /** Le lien porte-t-il la clé de ce téléphone ? (comparaison en temps constant) */
    static boolean valide(Context ctx, String recue) {
        if (recue == null) return false;
        return java.security.MessageDigest.isEqual(recue.getBytes(), cle(ctx).getBytes());
    }

    static boolean valide(Context ctx, Uri lien) {
        return lien != null && valide(ctx, lien.getQueryParameter(CLE));
    }
}
