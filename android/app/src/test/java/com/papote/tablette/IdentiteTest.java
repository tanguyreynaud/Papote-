package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Numéro T-… du stock gardé par la tablette (appui de 5 s sur l'heure) : seule la forme T-123 est acceptée. */
public class IdentiteTest {

    @Test
    public void refNormalisee() {
        assertEquals("T-003", Installation.refValide("T-003"));
        assertEquals("T-003", Installation.refValide("t003"));
        assertEquals("T-12", Installation.refValide(" T-12 "));
    }

    @Test
    public void refRefusee() {
        assertNull(Installation.refValide(null));
        assertNull(Installation.refValide("T-"));
        assertNull(Installation.refValide("X-003"));
        assertNull(Installation.refValide("T-123456"));
        assertNull(Installation.refValide("T-003; rm"));
    }
}
