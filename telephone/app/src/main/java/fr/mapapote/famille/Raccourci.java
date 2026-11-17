package fr.mapapote.famille;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import java.util.Collections;

/**
 * Raccourci « Mamie Jeanne » dans la première rangée du menu « Partager » d'Android (Tanguy, 11/11) :
 * un toucher depuis la Galerie, WhatsApp ou l'appareil photo, et Papote s'ouvre sur l'envoi à la
 * tablette, sans chercher Papote tout en bas de la liste.
 *
 * Android y montre les raccourcis « de conversation » publiés par les applis (res/xml/raccourcis.xml
 * dit qu'il accepte les photos et vidéos) ; le partage arrive à {@link Ouverture} comme le partage
 * classique. Le nom vient du dernier appel de la tablette (prénom de la personne) ; avant le premier
 * appel, « La tablette ». Android 10 et plus.
 */
final class Raccourci {
    private Raccourci() {}

    private static final String ID = "tablette";
    private static final String CATEGORIE = "fr.mapapote.famille.PARTAGE";
    private static final String PREFS = "raccourci";
    private static final String NOM = "nom";

    /** Au lancement : publié une fois, ou republié s'il a disparu (Android peut l'effacer). */
    static void verifier(Context ctx) {
        try {
            for (ShortcutInfoCompat r : ShortcutManagerCompat.getDynamicShortcuts(ctx)) {
                if (ID.equals(r.getId())) return;
            }
        } catch (Exception e) {
            // Liste illisible : on republie.
        }
        publier(ctx, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(NOM, ctx.getString(R.string.raccourci_defaut)));
    }

    /** Le nom de la personne de la tablette, s'il est déjà connu (sinon null). */
    static String nomConnu(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(NOM, null);
    }

    /** La tablette appelle : le raccourci prend le nom de la personne (sans « SOS : »). */
    static void nommer(Context ctx, String nom) {
        if (nom == null) return;
        nom = nom.replaceFirst("^SOS : ", "").trim();
        if (nom.isEmpty()) return;
        // La sonnerie revient toutes les 12 s : on ne republie que si le nom change.
        if (nom.equals(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(NOM, null))) return;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(NOM, nom).apply();
        publier(ctx, nom);
    }

    private static void publier(Context ctx, String nom) {
        try {
            Intent ouvrir = new Intent(Intent.ACTION_VIEW, Uri.parse(Appels.URL_APP))
                    .setClass(ctx, Ouverture.class);
            ShortcutInfoCompat r = new ShortcutInfoCompat.Builder(ctx, ID)
                    .setShortLabel(nom)
                    .setLongLabel(ctx.getString(R.string.raccourci_long, nom))
                    .setIcon(IconCompat.createWithResource(ctx, R.mipmap.ic_launcher))
                    .setIntent(ouvrir)
                    .setLongLived(true)
                    .setPerson(new Person.Builder().setName(nom).setImportant(true).build())
                    .setCategories(Collections.singleton(CATEGORIE))
                    .build();
            ShortcutManagerCompat.pushDynamicShortcut(ctx, r);
        } catch (Exception e) {
            // Lanceur sans raccourcis, ou limite d'Android : le partage classique reste là.
        }
    }
}
