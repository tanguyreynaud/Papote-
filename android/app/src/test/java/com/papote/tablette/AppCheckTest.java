package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Jeton App Check gardé par l'app Android : quand le garder, quand en chercher un neuf, quand attendre.
 * La page (appels.js) force un jeton neuf dès que Firebase le renouvellerait ; la synchronisation garde le sien
 * jusqu'à 5 min de la fin. Jamais deux appels au serveur coup sur coup, même si la page insiste.
 */
public class AppCheckTest {
    private static final long MIN = 60_000;
    private static final long T = 1_800_000_000_000L; // « maintenant »

    private static AppCheck.Quoi decider(boolean aJeton, long expire, long recuA, long prochainEssai, boolean force) {
        return AppCheck.decider(T, true, aJeton, expire, recuA, prochainEssai, force);
    }

    @Test
    public void sansCleRienNestDemande() {
        assertEquals(AppCheck.Quoi.ATTENDRE, AppCheck.decider(T, false, false, 0, 0, 0, false));
        assertEquals(AppCheck.Quoi.ATTENDRE, AppCheck.decider(T, false, false, 0, 0, 0, true));
    }

    @Test
    public void pasDeJetonOnEnCherche() {
        assertEquals(AppCheck.Quoi.CHERCHER, decider(false, 0, 0, 0, false));
        assertEquals(AppCheck.Quoi.CHERCHER, decider(false, 0, 0, 0, true));
    }

    @Test
    public void laSynchronisationGardeSonJetonJusquaCinqMinutesDeLaFin() {
        assertEquals(AppCheck.Quoi.GARDER, decider(true, T + 20 * MIN, T - 40 * MIN, 0, false));
        assertEquals(AppCheck.Quoi.GARDER, decider(true, T + 6 * MIN, T - 54 * MIN, 0, false));
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T + 4 * MIN, T - 56 * MIN, 0, false));
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T - MIN, T - 61 * MIN, 0, false));
    }

    @Test
    public void laPageObtientUnJetonNeufMemeSiLAncienEstEncoreValable() {
        // 40e minute d'un jeton d'une heure : Firebase le redemanderait en boucle, il en faut un neuf (19/11).
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T + 20 * MIN, T - 40 * MIN, 0, true));
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T + 54 * MIN, T - 6 * MIN, 0, true));
    }

    @Test
    public void unJetonToutJusteRecuNestPasRedemande() {
        assertEquals(AppCheck.Quoi.GARDER, decider(true, T + 59 * MIN, T - MIN, 0, true));
        assertEquals(AppCheck.Quoi.GARDER, decider(true, T + 56 * MIN, T - 4 * MIN, 0, true));
        // Horloge reculée depuis (remise à l'heure) : « reçu dans le futur » ne bloque pas le renouvellement.
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T + 59 * MIN, T + 30 * MIN, 0, true));
    }

    @Test
    public void apresUnEchecOnAttendDixMinutes() {
        assertEquals(AppCheck.Quoi.ATTENDRE, decider(true, T + 20 * MIN, T - 40 * MIN, T + 9 * MIN, true));
        assertEquals(AppCheck.Quoi.ATTENDRE, decider(false, 0, 0, T + MIN, false));
        assertEquals(AppCheck.Quoi.CHERCHER, decider(true, T + 20 * MIN, T - 40 * MIN, T - 1, true));
        // Le jeton gardé sert encore à la synchronisation pendant l'attente.
        assertEquals(AppCheck.Quoi.GARDER, decider(true, T + 20 * MIN, T - 40 * MIN, T + 9 * MIN, false));
        assertEquals(AppCheck.Quoi.ATTENDRE.name(), "ATTENDRE");
        assertEquals(10 * MIN, AppCheck.ATTENTE_ECHEC_MS);
        assertEquals(5 * MIN, AppCheck.FORCE_ECART_MS);
    }
}
