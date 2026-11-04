package com.papote.tablette;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Audit 05/11 (F-d) : un proche dont la demande d'entrée attend encore (status « pending ») ne doit
 * ni apparaître dans « Appeler », ni recevoir les appels et SMS du SOS (Sync.syncFamilyExtras).
 */
public class SyncProcheTest {

    @Test
    public void procheAccepteOuAncienSansStatus() {
        assertTrue(Sync.procheActif("famille", "active"));
        assertTrue(Sync.procheActif("famille", null)); // fiches d'avant le champ status
        assertTrue(Sync.procheActif(null, null));
    }

    @Test
    public void demandeEnAttenteEtTablettesExclues() {
        assertFalse(Sync.procheActif("famille", "pending"));
        assertFalse(Sync.procheActif("tablette", null));
        assertFalse(Sync.procheActif("tablette", "active"));
    }
}
