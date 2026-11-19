package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Délais des appels réglés à distance : bornes et valeurs absentes. (La lecture des champs Firestore
 * passe par org.json, imité dans ces essais : elle est couverte côté page par android/tests/delais-appel.test.js.)
 */
public class ReglagesAppelTest {
    @Test
    public void sansReponseEntre10Et45Secondes() {
        assertEquals(18000, ReglagesAppel.sansReponseMs(18.0));
        assertEquals(10000, ReglagesAppel.sansReponseMs(10.0));
        assertEquals(45000, ReglagesAppel.sansReponseMs(45.0));
        assertEquals(16500, ReglagesAppel.sansReponseMs(16.5));
        assertEquals(-1, ReglagesAppel.sansReponseMs(9.9));
        assertEquals(-1, ReglagesAppel.sansReponseMs(45.1));
        assertEquals(-1, ReglagesAppel.sansReponseMs(0.0));
    }

    @Test
    public void messagerieEntre0Et8Secondes() {
        assertEquals(4500, ReglagesAppel.messagerieMs(4.5));
        assertEquals(0, ReglagesAppel.messagerieMs(0.0)); // 0 : règle coupée, pas « absent »
        assertEquals(8000, ReglagesAppel.messagerieMs(8.0));
        assertEquals(-1, ReglagesAppel.messagerieMs(8.1));
        assertEquals(-1, ReglagesAppel.messagerieMs(-1.0));
    }

    @Test
    public void absentOuIllisible() {
        assertEquals(-1, ReglagesAppel.sansReponseMs(null));
        assertEquals(-1, ReglagesAppel.messagerieMs(null));
        assertEquals(-1, ReglagesAppel.sansReponseMs(Double.NaN));
        assertEquals(-1, ReglagesAppel.messagerieMs(Double.POSITIVE_INFINITY));
        assertEquals(-1, ReglagesAppel.nombre(null) == null ? -1 : 0);
    }
}
