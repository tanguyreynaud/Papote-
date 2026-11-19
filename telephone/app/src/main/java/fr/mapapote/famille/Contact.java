package fr.mapapote.famille;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.widget.Toast;

/**
 * « Enregistrer dans mes contacts » dans l'app famille (lien papote://contact?cle=…&nom=…&tel=…, Tanguy 19/11) :
 * ouvre l'écran « Créer un contact » d'Android, déjà rempli avec le nom et le numéro de la tablette. La personne
 * n'a plus qu'à toucher « Enregistrer ». Aucune autorisation : l'app ne lit ni n'écrit jamais elle-même les
 * contacts (pas de READ_CONTACTS ni de WRITE_CONTACTS, qui font peur).
 *
 * « Enregistré » ne se devine pas : seul l'écran des contacts le sait. S'il répond RESULT_OK, l'app famille est
 * rouverte avec ?contactFait=<numéro> (Ouverture) et note « Déjà dans vos contacts » sur le compte du proche.
 * Annulé, ou une appli de contacts qui ne répond rien : la page reste telle quelle, avec « C'est fait » à côté du
 * bouton pour le dire soi-même.
 *
 * Sans la clé de ce téléphone (Lien), le lien ne fait rien : une autre page ne peut pas faire enregistrer
 * « Mamie (Papote) » avec un autre numéro.
 */
public class Contact extends Activity {
    static final String EXTRA_FAIT = "contactFait";
    private static final int CREER = 1;
    private static final String OUVERT = "ouvert";

    /** L'écran « Créer un contact » est ouvert : un 2e lien (double appui) n'en ouvre pas un autre. */
    private boolean ouvert;
    private String numero;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            // Recréée pendant que l'écran des contacts était ouvert (rotation, mémoire) : on attend sa réponse.
            ouvert = savedInstanceState.getBoolean(OUVERT);
            numero = savedInstanceState.getString(EXTRA_FAIT);
            if (!ouvert) finish();
            return;
        }
        Uri lien = getIntent().getData();
        String tel = lien == null ? null : international(lien.getQueryParameter("tel"));
        String nom = lien == null ? null : nom(lien.getQueryParameter("nom"));
        if (!Lien.valide(this, lien) || tel == null || nom == null) {
            finish();
            return;
        }
        numero = "0" + tel.substring(3);
        try {
            startActivityForResult(creer(nom, tel), CREER);
            ouvert = true;
        } catch (ActivityNotFoundException | SecurityException e) {
            // Aucune appli de contacts : le numéro à recopier, sans fenêtre.
            Toast.makeText(this, getString(R.string.contact_impossible, espace(numero)), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Lien reçu pendant que l'écran des contacts est ouvert (2e appui) : ignoré.
    }

    @Override
    protected void onSaveInstanceState(Bundle etat) {
        super.onSaveInstanceState(etat);
        etat.putBoolean(OUVERT, ouvert);
        etat.putString(EXTRA_FAIT, numero);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CREER) return;
        ouvert = false;
        if (resultCode == RESULT_OK && numero != null) {
            startActivity(new Intent(this, Ouverture.class)
                    .setData(Uri.parse(getString(R.string.url_app)))
                    .putExtra(EXTRA_FAIT, numero));
        }
        finish();
    }

    /** « Créer un contact » d'Android, rempli. finishActivityOnSaveCompleted : revenir ici dès « Enregistrer ». */
    static Intent creer(String nom, String tel) {
        return new Intent(Intent.ACTION_INSERT, ContactsContract.Contacts.CONTENT_URI)
                .putExtra(ContactsContract.Intents.Insert.NAME, nom)
                .putExtra(ContactsContract.Intents.Insert.PHONE, tel)
                .putExtra(ContactsContract.Intents.Insert.PHONE_TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                .putExtra(ContactsContract.Intents.Insert.NOTES, "Tablette Papote")
                .putExtra("finishActivityOnSaveCompleted", true);
    }

    /** +33 puis un portable (6 ou 7) : le seul numéro qu'a une tablette Papote. Sinon null. */
    static String international(String tel) {
        return tel != null && tel.matches("\\+33[67][0-9]{8}") ? tel : null;
    }

    /** Le nom affiché du contact (« Mamie Emma (Papote) ») : une ligne, 60 caractères au plus. Sinon null. */
    static String nom(String nom) {
        if (nom == null) return null;
        String propre = nom.replaceAll("\\p{Cntrl}", " ").trim();
        return propre.isEmpty() || propre.length() > 60 ? null : propre;
    }

    private static String espace(String national) {
        return national.replaceAll("(\\d{2})(?=\\d)", "$1 ");
    }

}
