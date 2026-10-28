package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import org.junit.Test;

/** Petites fonctions de la tablette, essayées sans tablette (gradlew test). */
public class OutilsTest {

    @Test
    public void veilleDeNuitPasseMinuit() {
        assertTrue(Veille.inRange(23, 23, 7));
        assertTrue(Veille.inRange(0, 23, 7));
        assertTrue(Veille.inRange(6, 23, 7));
        assertFalse(Veille.inRange(7, 23, 7));
        assertFalse(Veille.inRange(12, 23, 7));
        assertFalse(Veille.inRange(22, 23, 7));
    }

    @Test
    public void veilleDansLaJournee() {
        assertTrue(Veille.inRange(13, 13, 15));
        assertFalse(Veille.inRange(15, 13, 15));
        assertFalse(Veille.inRange(9, 9, 9)); // de == a : jamais
    }

    @Test
    public void horodatageFirestore() {
        assertEquals(1761469200000L, Firebase.parseTimestamp("2025-10-26T09:00:00Z"));
        assertEquals(1761469200123L, Firebase.parseTimestamp("2025-10-26T09:00:00.123456Z"));
        assertEquals(1761469200500L, Firebase.parseTimestamp("2025-10-26T09:00:00.5Z"));
        assertEquals(0, Firebase.parseTimestamp(null));
        assertEquals(0, Firebase.parseTimestamp("2025-10-26"));
        assertEquals(0, Firebase.parseTimestamp("pas une date du tout"));
    }

    @Test
    public void symbolesMeteo() {
        assertEquals(0, Meteo.wmo("clearsky_day"));
        assertEquals(2, Meteo.wmo("partlycloudy_night"));
        assertEquals(80, Meteo.wmo("lightrainshowers_polartwilight"));
        assertEquals(95, Meteo.wmo("heavyrainandthunder"));
        assertEquals(3, Meteo.wmo(null));
    }

    @Test
    public void jetonAppCheckSeulementPourFirebase() {
        assertTrue(AppCheck.concerne("https://firestore.googleapis.com/v1/projects/x"));
        assertTrue(AppCheck.concerne("https://firebasestorage.googleapis.com/v0/b/x/o/y"));
        assertTrue(AppCheck.concerne("https://voix-abc.a.run.app/photo"));
        assertFalse(AppCheck.concerne("https://pirate.example/x.run.app/photo.jpg"));
        assertFalse(AppCheck.concerne("http://firestore.googleapis.com/v1"));
        assertFalse(AppCheck.concerne(null));
    }

    @Test
    public void ecrituresGardeesSeulementSiCaPeutPasser() {
        assertTrue(Sync.retryable(new IOException("pas de réseau")));
        assertTrue(Sync.retryable(new Firebase.ApiException(503, "")));
        assertTrue(Sync.retryable(new Firebase.ApiException(429, "")));
        assertTrue(Sync.retryable(new Firebase.ApiException(401, "")));
        assertFalse(Sync.retryable(new Firebase.ApiException(400, "FAILED_PRECONDITION"))); // envoi supprimé
        assertFalse(Sync.retryable(new Firebase.ApiException(403, "")));
        assertFalse(Sync.retryable(new Firebase.ApiException(404, "")));
    }

    @Test
    public void forfaitPaliers() {
        assertEquals(0, Forfait.niveau(1000, 0));
        assertEquals(0, Forfait.niveau(1000, 699));
        assertEquals(1, Forfait.niveau(1000, 700));
        assertEquals(2, Forfait.niveau(1000, 880));
        assertEquals(3, Forfait.niveau(1000, 950));
        assertEquals(0, Forfait.niveau(0, 5000));   // pas de limite
        assertEquals(0, Forfait.niveau(1000, -1));  // compteur inconnu : on ne bride pas
        assertEquals(1, Forfait.niveau(2000, 1500)); // forfait 2 Go : 75 %
    }

    @Test
    public void forfaitDebutDuCycle() {
        java.util.TimeZone paris = java.util.TimeZone.getTimeZone("Europe/Paris");
        java.util.Calendar c = java.util.Calendar.getInstance(paris);
        c.clear();
        c.set(2026, java.util.Calendar.OCTOBER, 28, 13, 0, 0);
        long now = c.getTimeInMillis();
        // Jour du mois : le 15 → 15 octobre ; le 1er → 1er octobre.
        c.clear(); c.set(2026, java.util.Calendar.OCTOBER, 15, 0, 0, 0);
        assertEquals(c.getTimeInMillis(), Forfait.debutCycle(15, "", now));
        c.clear(); c.set(2026, java.util.Calendar.OCTOBER, 1, 0, 0, 0);
        assertEquals(c.getTimeInMillis(), Forfait.debutCycle(1, "", now));
        // Recharge Lyca du 20 septembre, cycles de 30 jours : 20 septembre, 20 octobre.
        c.clear(); c.set(2026, java.util.Calendar.OCTOBER, 20, 0, 0, 0);
        assertEquals(c.getTimeInMillis(), Forfait.debutCycle(1, "2026-09-20", now));
        // Recharge dans le futur (faute de frappe) : cycle précédent, jamais une date après aujourd'hui.
        assertTrue(Forfait.debutCycle(1, "2026-11-05", now) < now);
    }
}
