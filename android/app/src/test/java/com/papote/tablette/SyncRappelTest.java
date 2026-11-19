package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Audit du 19/11 : un seul rappel mal formé (jour de la semaine hors limites, écrit par autre chose que
 * l'appli) arrêtait la lecture de tous les rappels de la famille : la tablette gardait les anciens, sans rien
 * dire. Les jours illisibles sont maintenant ignorés (Sync.jourDeRappel), et un rappel illisible est laissé de
 * côté sans toucher aux autres (Sync.syncReminders).
 */
public class SyncRappelTest {

    @Test
    public void joursDeLaSemaine() {
        assertEquals(0, Sync.jourDeRappel("0"));
        assertEquals(6, Sync.jourDeRappel("6"));
        assertEquals(3, Sync.jourDeRappel(" 3 "));
    }

    @Test
    public void valeursQuiFaisaientToutEchouer() {
        assertEquals(-1, Sync.jourDeRappel("99999999999")); // plus grand qu'un entier : exception avant
        assertEquals(-1, Sync.jourDeRappel("lundi"));
        assertEquals(-1, Sync.jourDeRappel(""));
        assertEquals(-1, Sync.jourDeRappel(null));
    }

    @Test
    public void joursHorsSemaineIgnores() {
        assertEquals(-1, Sync.jourDeRappel("7"));
        assertEquals(-1, Sync.jourDeRappel("-1"));
    }
}
