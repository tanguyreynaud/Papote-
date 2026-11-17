package fr.mapapote.famille;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * SOS de la tablette (A47) : sur le téléphone du proche, une alerte urgente et différente d'un appel
 * normal (canal SOS en alarme, son et vibration à part), qu'une notification suivante n'efface pas.
 * Messages du serveur passés tels quels à Sonnerie.recevoir, comme les envoie Firebase.
 * Android 9 (le plus ancien accepté) et Android 15.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class SosTest {
    private Application ctx;
    private NotificationManager nm;

    @Before
    public void preparer() {
        ctx = RuntimeEnvironment.getApplication();
        nm = ctx.getSystemService(NotificationManager.class);
    }

    private static Map<String, String> msg(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private List<Notification> affichees() {
        return new ArrayList<>(shadowOf(nm).getAllNotifications());
    }

    private List<Notification> surCanal(String canal) {
        List<Notification> l = new ArrayList<>();
        for (Notification n : affichees()) if (canal.equals(n.getChannelId())) l.add(n);
        return l;
    }

    private static String titre(Notification n) {
        CharSequence t = n.extras.getCharSequence(Notification.EXTRA_TITLE);
        return t == null ? null : t.toString();
    }

    @Test
    public void leCanalSosSonneEnAlarmeAvecUneVibrationAPart() {
        Appels.creerCanaux(ctx);
        NotificationChannel sos = nm.getNotificationChannel(Appels.CANAL_SOS);
        NotificationChannel appels = nm.getNotificationChannel(Appels.CANAL_APPELS);
        assertNotNull("canal SOS créé", sos);
        assertEquals(NotificationManager.IMPORTANCE_HIGH, sos.getImportance());
        assertEquals("son d'alarme : passe « Ne pas déranger » si les alarmes y sont permises",
                AudioAttributes.USAGE_ALARM, sos.getAudioAttributes().getUsage());
        assertTrue(sos.shouldVibrate());
        assertArrayEquals(Appels.VIBRATION_SOS, sos.getVibrationPattern());
        assertFalse("vibration différente d'un appel normal",
                java.util.Arrays.equals(appels.getVibrationPattern(), sos.getVibrationPattern()));
        assertEquals(Notification.VISIBILITY_PUBLIC, sos.getLockscreenVisibility());
        assertEquals(AudioAttributes.USAGE_NOTIFICATION_RINGTONE, appels.getAudioAttributes().getUsage());
    }

    @Test
    public void appelSosMarqueParLeServeur() {
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c1", "fid", "f1", "jeton", "j1", "nom", "Mamie Emma", "urgence", "sos"));
        List<Notification> l = surCanal(Appels.CANAL_SOS);
        assertEquals(1, l.size());
        Notification n = l.get(0);
        assertEquals("le style appel montre le nom de l'appelant, précédé de SOS", "SOS : Mamie Emma", titre(n));
        assertEquals(Notification.CATEGORY_ALARM, n.category);
        assertTrue("sonne en boucle", (n.flags & Notification.FLAG_INSISTENT) != 0);
        assertNotNull("plein écran, téléphone verrouillé", n.fullScreenIntent);
        assertEquals("rien sur le canal des appels normaux", 0, surCanal(Appels.CANAL_APPELS).size());
    }

    @Test
    public void appelSosDUnServeurDAvantLePrefixeSuffit() {
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c2", "nom", "SOS : Mamie"));
        List<Notification> l = surCanal(Appels.CANAL_SOS);
        assertEquals(1, l.size());
        assertEquals("pas « SOS : SOS : »", "SOS : Mamie", titre(l.get(0)));
    }

    @Test
    public void appelNormalInchange() {
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c3", "nom", "Mamie"));
        assertEquals(0, surCanal(Appels.CANAL_SOS).size());
        List<Notification> l = surCanal(Appels.CANAL_APPELS);
        assertEquals(1, l.size());
        assertEquals("Mamie", titre(l.get(0)));
        assertEquals(Notification.CATEGORY_CALL, l.get(0).category);
    }

    @Test
    public void lesRenvoisDuServeurNeDoublentPasLaSonnerieSos() {
        for (int i = 0; i < 3; i++) {
            Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c4", "nom", "Mamie", "urgence", "sos"));
        }
        assertEquals(1, surCanal(Appels.CANAL_SOS).size());
    }

    @Test
    public void quelquUnADecrocheLaSonnerieSosSArrete() {
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c5", "nom", "Mamie", "urgence", "sos"));
        Sonnerie.recevoir(ctx, msg("type", "fin", "cid", "c5"));
        assertEquals(0, surCanal(Appels.CANAL_SOS).size());
        // Un renvoi en retard ne la refait pas sonner.
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c5", "nom", "Mamie", "urgence", "sos"));
        assertEquals(0, surCanal(Appels.CANAL_SOS).size());
    }

    @Test
    public void unAppelNormalPendantLeSosNEffacePasLeSos() {
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c6", "nom", "Mamie", "urgence", "sos"));
        Sonnerie.recevoir(ctx, msg("type", "appel", "cid", "c7", "nom", "Mamie"));
        Sonnerie.recevoir(ctx, msg("type", "manque", "cid", "c7", "nom", "Mamie"));
        assertEquals(1, surCanal(Appels.CANAL_SOS).size());
    }

    @Test
    public void alerteSosSansReponseGardeeMalgreLAlerteSuivante() {
        Sonnerie.recevoir(ctx, msg("type", "alerte", "titre", "Mamie a appuyé sur SOS",
                "texte", "Personne n'a pu répondre. Rappelez dès que possible.", "urgence", "sos"));
        Sonnerie.recevoir(ctx, msg("type", "alerte", "titre", "La tablette est débranchée", "texte", "Rebranchez-la."));
        Sonnerie.recevoir(ctx, msg("type", "alerte", "titre", "La tablette est silencieuse", "texte", "Montez le son."));
        List<Notification> sos = surCanal(Appels.CANAL_SOS);
        assertEquals(1, sos.size());
        assertEquals("Mamie a appuyé sur SOS", titre(sos.get(0)));
        assertEquals(Notification.CATEGORY_ALARM, sos.get(0).category);
        assertTrue("effacée seulement quand le proche la touche", (sos.get(0).flags & Notification.FLAG_AUTO_CANCEL) != 0);
        assertEquals("pas de délai d'expiration", 0, sos.get(0).getTimeoutAfter());
        assertNotNull(shadowOf(nm).getNotification(Appels.TAG_SOS, 4));
        // Les alertes ordinaires restent sur le canal habituel (la dernière remplace la précédente).
        assertEquals(1, surCanal(Appels.CANAL_INFOS).size());
    }

    @Test
    public void alerteSosDUnServeurDAvantReconnueAuTitre() {
        Sonnerie.recevoir(ctx, msg("type", "alerte", "titre", "Mamie a appuyé sur SOS", "texte", "Personne n'a pu répondre."));
        assertEquals(1, surCanal(Appels.CANAL_SOS).size());
        assertEquals(0, surCanal(Appels.CANAL_INFOS).size());
    }

    @Test
    public void reconnaissanceDuSos() {
        assertTrue(Appels.estSos("sos", "Mamie", null));
        assertTrue(Appels.estSos(null, "SOS : Mamie", null));
        assertTrue(Appels.estSos(null, null, "Mamie a appuyé sur SOS"));
        assertFalse(Appels.estSos(null, "Mamie", null));
        assertFalse(Appels.estSos("", "Sosthène", "Sosthène vous a envoyé une photo"));
        assertEquals("Mamie", Appels.sansSos("SOS : Mamie"));
        assertEquals("Mamie", Appels.sansSos("Mamie"));
        assertNull(Appels.sansSos(null));
    }
}
