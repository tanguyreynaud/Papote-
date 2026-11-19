package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Secours du push sous verrou (Tanguy, 19/11) : 24 h d'écoute directe au plus, puis secours bridé ;
 * jamais plus, même après un redémarrage, un push qui clignote ou une coupure de réseau.
 */
public class SecoursPushTest {
    private static final long MIN = 60_000, H = 60 * MIN, JOUR = 24 * H;
    private static final long PAS = 30_000; // le chien de garde compte toutes les 30 s

    private static SecoursPush.Compteurs neuf() {
        return new SecoursPush.Compteurs(0, 0, 0);
    }

    /** Fait passer « duree » dans cet état, par pas de 30 s ; renvoie le temps passé en écoute directe. */
    private static long passer(SecoursPush.Compteurs c, boolean push, boolean enLigne, long duree) {
        long direct = 0;
        for (long t = 0; t < duree; t += PAS) {
            if (enLigne && SecoursPush.DIRECT.equals(SecoursPush.mode(push, c.direct))) direct += PAS;
            SecoursPush.avancer(c, push, enLigne, PAS);
        }
        return direct;
    }

    @Test
    public void pushQuiMarcheAucuneEcoute() {
        SecoursPush.Compteurs c = neuf();
        assertEquals(0, passer(c, true, true, 3 * JOUR));
        assertEquals(SecoursPush.PUSH, SecoursPush.mode(true, c.direct));
        assertEquals(0, c.direct);
    }

    @Test
    public void troisJoursSansPushEcouteDirecte24hPuisBride() {
        SecoursPush.Compteurs c = neuf();
        long direct = passer(c, false, true, 3 * JOUR);
        assertEquals("24 h d'écoute directe, pas une minute de plus", JOUR, direct);
        assertEquals(SecoursPush.BRIDE, SecoursPush.mode(false, c.direct));
    }

    @Test
    public void leRedemarrageNeRedonnePas24h() {
        SecoursPush.Compteurs c = neuf();
        long direct = passer(c, false, true, 20 * H);
        // Redémarrage : seuls les compteurs enregistrés reviennent (le temps de panne d'affilée repart de zéro).
        SecoursPush.Compteurs apres = new SecoursPush.Compteurs(c.direct, c.sain, 0);
        direct += passer(apres, false, true, 2 * JOUR);
        assertEquals(JOUR, direct);
        assertEquals(SecoursPush.BRIDE, SecoursPush.mode(false, apres.direct));
    }

    @Test
    public void pushQuiClignoteNeRedonnePas24h() {
        SecoursPush.Compteurs c = neuf();
        long direct = 0;
        // 10 jours : le push revient 1 h puis retombe 5 h, sans arrêt.
        for (int i = 0; i < 40; i++) {
            direct += passer(c, false, true, 5 * H);
            direct += passer(c, true, true, H);
        }
        assertEquals("24 h d'écoute directe en tout", JOUR, direct);
        assertEquals(SecoursPush.BRIDE, SecoursPush.mode(false, c.direct));
    }

    @Test
    public void septJoursDePushSainRendentLes24h() {
        SecoursPush.Compteurs c = neuf();
        passer(c, false, true, 3 * JOUR);
        passer(c, true, true, 6 * JOUR);
        assertEquals("6 jours ne suffisent pas", SecoursPush.BRIDE, SecoursPush.mode(false, c.direct));
        passer(c, true, true, JOUR + H);
        assertEquals(SecoursPush.DIRECT, SecoursPush.mode(false, c.direct));
        assertEquals(0, c.direct);
    }

    @Test
    public void uneCourteAbsenceDuPushNEffacePasLesJoursSains() {
        SecoursPush.Compteurs c = neuf();
        passer(c, false, true, 3 * JOUR);
        // Contrôle quotidien : le push n'est pas « prêt » pendant 2 min chaque jour.
        for (int j = 0; j < 8; j++) {
            passer(c, true, true, JOUR - 2 * MIN);
            passer(c, false, true, 2 * MIN);
        }
        assertTrue("les 24 h sont rendues malgré les 2 min par jour", c.direct < H);
    }

    @Test
    public void unePanneDe10MinRemetLesJoursSainsAZero() {
        SecoursPush.Compteurs c = neuf();
        passer(c, false, true, 3 * JOUR);
        passer(c, true, true, 6 * JOUR);
        passer(c, false, true, 15 * MIN);
        passer(c, true, true, 2 * JOUR);
        assertEquals("6 jours + 2 jours coupés par une panne : pas 7 d'affilée", SecoursPush.BRIDE, SecoursPush.mode(false, c.direct));
    }

    @Test
    public void sansReseauRienNEstCompte() {
        SecoursPush.Compteurs c = neuf();
        passer(c, false, false, 5 * JOUR);
        assertEquals(0, c.direct);
        assertEquals(0, c.hors);
        // Au retour du réseau, les 24 h sont intactes.
        assertEquals(JOUR, passer(c, false, true, 3 * JOUR));
    }

    @Test
    public void unTrouDansLeTempsCompteAuPlus2Min() {
        SecoursPush.Compteurs c = neuf();
        SecoursPush.avancer(c, false, true, 9 * H); // tablette endormie, chronomètre qui a couru
        assertEquals(SecoursPush.PAS_MAX_MS, c.direct);
        SecoursPush.avancer(c, false, true, -5 * H); // jamais de pas négatif
        assertEquals(SecoursPush.PAS_MAX_MS, c.direct);
    }

    @Test
    public void nouveauJetonDemandeToutesLes6hDePanne() {
        assertFalse(SecoursPush.nouveauJetonDu(0, 30_000));
        assertTrue(SecoursPush.nouveauJetonDu(6 * H - 10_000, 6 * H + 20_000));
        assertFalse(SecoursPush.nouveauJetonDu(6 * H + 20_000, 6 * H + 50_000));
        assertTrue(SecoursPush.nouveauJetonDu(12 * H - 1, 12 * H));
    }
}
