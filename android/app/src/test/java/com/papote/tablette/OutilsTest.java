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
}
