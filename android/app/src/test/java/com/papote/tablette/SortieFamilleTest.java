package com.papote.tablette;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Sortie de la famille : jamais sur un simple refus du serveur (audit réseau du 11/11), sans tablette. */
public class SortieFamilleTest {
    @Test
    public void ficheSupprimeeEtServeurQuiRepond() {
        assertTrue(SortieFamille.ficheDisparue(403, 200)); // tablette retirée : les règles refusent sa fiche
        assertTrue(SortieFamille.ficheDisparue(404, 200));
        assertTrue(SortieFamille.ficheDisparue(403, 404)); // témoin absent mais lisible : le serveur répond
    }

    @Test
    public void toutEstRefuseLaTabletteResteDansSaFamille() {
        // Règles cassées, App Check exigé sans jeton, facturation coupée, clé restreinte : le témoin est refusé aussi.
        assertFalse(SortieFamille.ficheDisparue(403, 403));
        assertFalse(SortieFamille.ficheDisparue(403, 401));
        assertFalse(SortieFamille.ficheDisparue(403, 429));
        assertFalse(SortieFamille.ficheDisparue(403, 500));
        assertFalse(SortieFamille.ficheDisparue(403, 503));
        assertFalse(SortieFamille.ficheDisparue(404, 403));
    }

    @Test
    public void coupureDeReseauLaTabletteResteDansSaFamille() {
        assertFalse(SortieFamille.ficheDisparue(0, 0));
        assertFalse(SortieFamille.ficheDisparue(403, 0)); // le témoin n'a pas pu être lu : on ne sait pas
        assertFalse(SortieFamille.ficheDisparue(0, 200));
    }

    @Test
    public void ficheToujoursLaOnReste() {
        assertFalse(SortieFamille.ficheDisparue(200, 200));
        assertFalse(SortieFamille.ficheDisparue(500, 200));
        assertFalse(SortieFamille.ficheDisparue(429, 200));
    }

    @Test
    public void ilFautTroisConstatsSurUnQuartDHeure() {
        long quart = 15 * 60_000L;
        assertFalse(SortieFamille.quitter(0, 10 * quart, false));
        assertFalse(SortieFamille.quitter(1, 0, false));
        assertFalse(SortieFamille.quitter(2, quart, false));
        assertFalse(SortieFamille.quitter(3, quart - 1, false)); // trois constats en trois minutes : pas encore
        assertFalse(SortieFamille.quitter(50, 60_000, false));
        assertTrue(SortieFamille.quitter(3, quart, false));
        assertTrue(SortieFamille.quitter(16, quart + 60_000, false));
    }

    @Test
    public void pendantUneInstallationLEcranDuCodeRevientToutDeSuite() {
        assertTrue(SortieFamille.quitter(1, 0, true)); // « Recommencer » sur le téléphone
        assertFalse(SortieFamille.quitter(0, 0, true));
    }
}
