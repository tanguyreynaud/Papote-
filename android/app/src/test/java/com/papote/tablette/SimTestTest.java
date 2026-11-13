package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import android.telephony.TelephonyManager;

import org.junit.Test;

/** « Installer la carte SIM » : l'état rendu au serveur (contrat avec l'admin, 13/11). */
public class SimTestTest {

    @Test
    public void carteEtCode() {
        assertEquals("", SimTest.carte(TelephonyManager.SIM_STATE_READY));
        assertEquals("pin", SimTest.carte(TelephonyManager.SIM_STATE_PIN_REQUIRED));
        assertEquals("puk", SimTest.carte(TelephonyManager.SIM_STATE_PUK_REQUIRED));
        assertEquals("verrouillee", SimTest.carte(TelephonyManager.SIM_STATE_NETWORK_LOCKED));
        assertEquals("absente", SimTest.carte(TelephonyManager.SIM_STATE_ABSENT));
    }

    @Test
    public void unProblemeEmpecheLesSuivants() {
        assertEquals("ok", SimTest.etat("", "208", true, false, true));
        assertEquals("pin", SimTest.etat("pin", "", false, false, false));
        assertEquals("absente", SimTest.etat("absente", null, false, false, false));
        assertEquals("T-003, 12/11 : Lyca passée en 260", "etrangere", SimTest.etat("", "260", true, false, true));
        assertEquals("sans-reseau", SimTest.etat("", "208", false, false, false));
        assertEquals("itinérance : refusé", "sans-reseau", SimTest.etat("", "208", true, true, true));
        assertEquals("donnees-ko", SimTest.etat("", "208", true, false, false));
    }
}
