package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * Sortie de la famille (audit réseau du 11/11, décision de Tanguy du 12/11) : seulement après 72 h de refus
 * continu, jamais à cause d'une absence de réseau, compteur gardé après un redémarrage. Sans tablette.
 */
public class SortieFamilleTest {
    private static final long MIN = 60_000L;
    private static final long HEURE = 60 * MIN;
    private static final long T0 = 1_794_000_000_000L; // novembre 2026

    @Test
    public void ficheSupprimeeEtServeurQuiRepond() {
        assertTrue(SortieFamille.ficheDisparue(403, 200)); // tablette retirée : les règles refusent sa fiche
        assertTrue(SortieFamille.ficheDisparue(404, 200));
        assertTrue(SortieFamille.ficheDisparue(403, 404)); // base vidée : témoin absent mais lisible, le serveur répond
        assertEquals(SortieFamille.Constat.REFUS, SortieFamille.constat(403, 404));
    }

    @Test
    public void toutEstRefuseOnNeSaitPas() {
        // Règles cassées, App Check exigé sans jeton, facturation coupée, clé restreinte : le témoin est refusé aussi.
        for (int t : new int[] {403, 401, 429, 500, 503}) {
            assertFalse(SortieFamille.ficheDisparue(403, t));
            assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(403, t));
        }
        assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(404, 403));
    }

    @Test
    public void sansReseauOnNeSaitPas() {
        assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(0, 0));
        assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(403, 0)); // témoin pas lu
        assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(0, 200));
        assertEquals(SortieFamille.Constat.INCERTAIN, SortieFamille.constat(500, 200));
        assertEquals(SortieFamille.Constat.LUE, SortieFamille.constat(200, 200));
    }

    /** Un refus toutes les 30 minutes pendant cette durée ; rend vrai si la tablette a quitté sa famille. */
    private static boolean refusPendant(SortieFamille.Compteur c, long debut, long duree) {
        for (long t = debut; t <= debut + duree; t += 30 * MIN) {
            c.noter(SortieFamille.Constat.REFUS, t);
            if (SortieFamille.quitter(c, true, false)) return true;
        }
        return false;
    }

    @Test
    public void ilFaut72HeuresDeRefusContinu() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        assertFalse("un premier refus ne suffit pas", refusPendant(c, T0, 0));
        assertFalse("trois constats en un quart d'heure (ancienne règle) ne suffisent plus", refusPendant(c, T0 + 30 * MIN, HEURE));
        c = new SortieFamille.Compteur(0, 0);
        assertFalse("71 h 30 de refus : elle reste", refusPendant(c, T0, 71 * HEURE + 30 * MIN));
        c.noter(SortieFamille.Constat.REFUS, T0 + 72 * HEURE);
        assertTrue("72 h de refus continu : elle quitte sa famille", SortieFamille.quitter(c, true, false));
    }

    @Test
    public void pendantLes72HeuresElleNeQuitteJamaisSurUnConstatQuiNEstPasUnRefus() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(80 * HEURE, T0);
        assertFalse(SortieFamille.quitter(c, false, false)); // pas de refus à l'instant : on ne part pas
    }

    @Test
    public void lAbsenceDeReseauNeCompteJamaisCommeUnRefus() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        // 24 h de refus, puis 3 jours sans réseau (un tour toutes les heures), puis de nouveau des refus.
        assertFalse(refusPendant(c, T0, 24 * HEURE));
        long apres = T0 + 24 * HEURE;
        for (long t = apres + HEURE; t < apres + 72 * HEURE; t += HEURE) {
            c.noter(SortieFamille.Constat.INCERTAIN, t);
            assertFalse(SortieFamille.quitter(c, false, false));
        }
        assertEquals("sans réseau, rien n'est effacé non plus", 24 * HEURE, c.cumulMs);
        long reprise = apres + 72 * HEURE;
        c.noter(SortieFamille.Constat.REFUS, reprise);
        assertFalse("les 3 jours sans réseau ne sont pas comptés", SortieFamille.quitter(c, true, false));
        assertEquals(24 * HEURE, c.cumulMs);
        // Il faut encore 48 h de vrais refus.
        assertFalse(refusPendant(c, reprise + 30 * MIN, 47 * HEURE));
        assertTrue(refusPendant(c, reprise + 47 * HEURE + 30 * MIN, 2 * HEURE));
    }

    @Test
    public void quatreJoursSansAucunReseauLaTabletteGardeSaFamille() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        for (long t = T0; t < T0 + 96 * HEURE; t += HEURE) {
            c.noter(SortieFamille.Constat.INCERTAIN, t);
            assertFalse(SortieFamille.quitter(c, false, false));
        }
        assertTrue(c.vide());
    }

    @Test
    public void uneLectureReussieRemetLeCompteurAZero() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        assertFalse(refusPendant(c, T0, 70 * HEURE));
        c.noter(SortieFamille.Constat.LUE, T0 + 70 * HEURE + 30 * MIN);
        assertTrue(c.vide());
        assertFalse("après la lecture réussie, il faut de nouveau 72 h", refusPendant(c, T0 + 71 * HEURE, 71 * HEURE));
    }

    @Test
    public void tabletteEteinteLeTempsEteintNeComptePas() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        assertFalse(refusPendant(c, T0, 10 * HEURE));
        // Éteinte 2 jours : le refus suivant ne compte pas ce trou.
        c.noter(SortieFamille.Constat.REFUS, T0 + 58 * HEURE);
        assertEquals(10 * HEURE, c.cumulMs);
        // Horloge remise en arrière : rien de compté non plus.
        c.noter(SortieFamille.Constat.REFUS, T0);
        assertEquals(10 * HEURE, c.cumulMs);
    }

    @Test
    public void leCompteurSurvitAUnRedemarrage() {
        Map<String, Long> reglages = new HashMap<>(); // les réglages gardés sur la tablette
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        assertFalse(refusPendant(c, T0, 50 * HEURE));
        c.garder((cle, v) -> { if (v == null) reglages.remove(cle); else reglages.put(cle, v); });
        // Redémarrage (10 min) : l'appli repart de zéro en mémoire, relit ses réglages.
        SortieFamille.Compteur relu = SortieFamille.Compteur.relire(cle -> reglages.getOrDefault(cle, 0L));
        assertEquals(50 * HEURE, relu.cumulMs);
        assertEquals(T0 + 50 * HEURE, relu.dernierRefus);
        assertFalse(refusPendant(relu, T0 + 50 * HEURE + 10 * MIN, 21 * HEURE));
        assertTrue("les 50 h d'avant le redémarrage comptent toujours", refusPendant(relu, T0 + 71 * HEURE + 40 * MIN, HEURE));
        // Lecture réussie : les clés sont effacées.
        relu.lue();
        relu.garder((cle, v) -> { if (v == null) reglages.remove(cle); else reglages.put(cle, v); });
        assertTrue(reglages.isEmpty());
        assertTrue(SortieFamille.Compteur.relire(cle -> reglages.getOrDefault(cle, 0L)).vide());
    }

    @Test
    public void pendantUneInstallationLAnnulationEstImmediate() {
        SortieFamille.Compteur c = new SortieFamille.Compteur(0, 0);
        c.noter(SortieFamille.Constat.REFUS, T0);
        assertTrue(SortieFamille.quitter(c, true, true)); // installation annulée côté serveur
        assertFalse(SortieFamille.quitter(c, false, true)); // sans réseau, même pendant l'installation : on reste
    }
}
