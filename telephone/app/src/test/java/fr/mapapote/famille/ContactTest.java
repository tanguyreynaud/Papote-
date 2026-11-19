package fr.mapapote.famille;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.ContactsContract;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowActivity;

/**
 * « Enregistrer dans mes contacts » (Tanguy, 19/11) : le lien papote://contact de l'app famille ouvre « Créer un
 * contact » d'Android, rempli, une seule fois ; « Enregistrer » rouvre l'app famille avec le numéro ; annulé, rien.
 * Jamais d'autorisation sur les contacts. Android 9 (le plus ancien accepté) et Android 15.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class ContactTest {
    private Application ctx;
    private String cle;

    @Before
    public void preparer() {
        ctx = RuntimeEnvironment.getApplication();
        cle = Lien.cle(ctx);
    }

    private Intent lien(String cleDonnee, String nom, String tel) {
        Uri.Builder u = new Uri.Builder().scheme("papote").authority("contact");
        if (cleDonnee != null) u.appendQueryParameter("cle", cleDonnee);
        if (nom != null) u.appendQueryParameter("nom", nom);
        if (tel != null) u.appendQueryParameter("tel", tel);
        return new Intent(Intent.ACTION_VIEW, u.build()).setClass(ctx, Contact.class);
    }

    private ActivityController<Contact> ouvrir(Intent i) {
        return Robolectric.buildActivity(Contact.class, i).create().start().resume();
    }

    /**
     * L'écran « Créer un contact » ouvert par l'activité (null s'il n'y en a pas). Robolectric note un
     * startActivityForResult dans deux listes : il est retiré des deux, pour que getNextStartedActivity ne
     * montre ensuite que ce qui a été ouvert après.
     */
    private static ShadowActivity.IntentForResult ecranOuvert(Activity a) {
        ShadowActivity.IntentForResult r = shadowOf(a).getNextStartedActivityForResult();
        if (r != null) assertTrue(r.intent.filterEquals(shadowOf(a).getNextStartedActivity()));
        return r;
    }

    @Test
    public void aucuneAutorisationSurLesContacts() throws Exception {
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), PackageManager.GET_PERMISSIONS);
        if (info.requestedPermissions == null) return;
        for (String p : info.requestedPermissions) assertFalse(p, p.contains("CONTACTS"));
    }

    @Test
    public void ouvreCreerUnContactRempli() {
        Contact a = ouvrir(lien(cle, "Mamie Emma (Papote)", "+33612345678")).get();
        ShadowActivity.IntentForResult creer = ecranOuvert(a);
        assertEquals(Intent.ACTION_INSERT, creer.intent.getAction());
        assertEquals(ContactsContract.Contacts.CONTENT_URI, creer.intent.getData());
        assertEquals("Mamie Emma (Papote)", creer.intent.getStringExtra(ContactsContract.Intents.Insert.NAME));
        assertEquals("+33612345678", creer.intent.getStringExtra(ContactsContract.Intents.Insert.PHONE));
        assertEquals(ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
                creer.intent.getIntExtra(ContactsContract.Intents.Insert.PHONE_TYPE, -1));
        assertTrue(creer.intent.getBooleanExtra("finishActivityOnSaveCompleted", false));
        assertFalse("attend la réponse de l'écran des contacts", a.isFinishing());
        assertNull("un seul écran", ecranOuvert(a));
        assertNull("rien d'autre", shadowOf(a).getNextStartedActivity());
    }

    @Test
    public void doubleAppuiUnSeulEcran() {
        ActivityController<Contact> c = ouvrir(lien(cle, "Mamie Emma (Papote)", "+33612345678"));
        assertTrue(ecranOuvert(c.get()) != null);
        c.newIntent(lien(cle, "Mamie Emma (Papote)", "+33612345678"));
        assertNull(ecranOuvert(c.get()));
        assertNull(shadowOf(c.get()).getNextStartedActivity());
    }

    @Test
    public void enregistreRouvreLAppFamilleAvecLeNumero() {
        Contact a = ouvrir(lien(cle, "Mamie Emma (Papote)", "+33612345678")).get();
        ShadowActivity.IntentForResult creer = ecranOuvert(a);
        shadowOf(a).receiveResult(creer.intent, Activity.RESULT_OK, new Intent());
        Intent suite = shadowOf(a).getNextStartedActivity();
        assertEquals(Ouverture.class.getName(), suite.getComponent().getClassName());
        assertEquals("0612345678", suite.getStringExtra(Contact.EXTRA_FAIT));
        assertEquals("https://app.mapapote.fr/", String.valueOf(suite.getData()));
        assertTrue(a.isFinishing());
    }

    @Test
    public void annuleNeRouvreRien() {
        Contact a = ouvrir(lien(cle, "Mamie Emma (Papote)", "+33712345678")).get();
        ShadowActivity.IntentForResult creer = ecranOuvert(a);
        shadowOf(a).receiveResult(creer.intent, Activity.RESULT_CANCELED, null);
        assertNull(shadowOf(a).getNextStartedActivity());
        assertTrue(a.isFinishing());
    }

    @Test
    public void lienSansLaBonneCleOuMalFormeNeFaitRien() {
        Intent[] mauvais = {
            lien(null, "Mamie Emma (Papote)", "+33612345678"),
            lien("pas-la-cle", "Mamie Emma (Papote)", "+33612345678"),
            lien(cle, "Mamie Emma (Papote)", "0612345678"),
            lien(cle, "Mamie Emma (Papote)", "+33112345678"),
            lien(cle, "Mamie Emma (Papote)", null),
            lien(cle, "", "+33612345678"),
            lien(cle, "x".repeat(61), "+33612345678"),
        };
        for (Intent i : mauvais) {
            Contact a = ouvrir(i).get();
            assertNull(i.getDataString(), ecranOuvert(a));
            assertNull(i.getDataString(), shadowOf(a).getNextStartedActivity());
            assertTrue(i.getDataString(), a.isFinishing());
        }
    }

    @Test
    public void unLienNeDonnePasLeNumeroALaPage() {
        // https://app.mapapote.fr/?contactFait=… ouvert par l'app : retiré, seule Contact le donne (Ouverture).
        Uri recue = Uri.parse("https://app.mapapote.fr/?contactFait=0612345678&contacts=1&famille=abc");
        assertEquals("https://app.mapapote.fr/?famille=abc", Ouverture.sansParamsApp(recue).build().toString());
    }
}
