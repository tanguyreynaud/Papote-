package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** L'heure du « Je m'en occupe » (families/{fid}.sosPris.le), sans JSON (org.json est factice ici). */
public class SosPrisTest {
    @Test
    public void horodatageFirestore() {
        assertEquals(1795177800123L, SosPris.instant("2026-11-20T12:30:00.123Z", null));
        assertEquals(1795177800000L, SosPris.instant("2026-11-20T12:30:00Z", ""));
    }

    @Test
    public void millisecondes() {
        assertEquals(1795177800123L, SosPris.instant(null, "1795177800123"));
        assertEquals(1795177800123L, SosPris.instant("", "1795177800123"));
    }

    @Test
    public void inutilisable() {
        assertEquals(-1, SosPris.instant(null, null));
        assertEquals(-1, SosPris.instant("", ""));
        assertEquals(-1, SosPris.instant("hier", null));
        assertEquals(-1, SosPris.instant(null, "bientôt"));
    }
}
