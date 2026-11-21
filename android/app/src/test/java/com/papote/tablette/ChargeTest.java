package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Limite de charge à 80 % qui ne reprend pas (Tanguy, 20/11) : quand Papote relance la charge. */
public class ChargeTest {
    private static final long MIN = 60_000, H = 60 * MIN, JAMAIS = Long.MAX_VALUE / 2;

    @Test
    public void rienQuandToutVaBien() {
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, true, 30, JAMAIS, false, JAMAIS, false));   // elle charge
        assertEquals(Charge.Geste.RIEN, Charge.decider(false, false, 30, JAMAIS, false, JAMAIS, false)); // débranchée
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 79, JAMAIS, false, JAMAIS, false));  // limite à 80 %, normal
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 70, JAMAIS, false, JAMAIS, false));
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, -1, JAMAIS, false, JAMAIS, false));  // niveau inconnu
    }

    @Test
    public void sousSoixanteOnRetoucheLeReglageDAbord() {
        assertEquals(Charge.Geste.REGLAGE, Charge.decider(true, false, 59, JAMAIS, false, JAMAIS, false));
        assertEquals(Charge.Geste.REGLAGE, Charge.decider(true, false, 20, JAMAIS, false, JAMAIS, false));
    }

    @Test
    public void onLaisseCinqMinutesALaChargePourRepartir() {
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 45, 2 * MIN, false, JAMAIS, false));
    }

    @Test
    public void reglageSansEffetRedemarrageSousCinquante() {
        assertEquals(Charge.Geste.REDEMARRER, Charge.decider(true, false, 49, 6 * MIN, false, JAMAIS, false));
        assertEquals(Charge.Geste.REDEMARRER, Charge.decider(true, false, 49, 0, true, JAMAIS, false)); // réglage refusé
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 55, 6 * MIN, false, JAMAIS, false)); // pas encore
    }

    @Test
    public void jamaisDeRedemarrageEnAppelNiDeuxEnTroisHeures() {
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 40, 6 * MIN, false, JAMAIS, true));
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 40, 6 * MIN, false, 2 * H, false));
        assertEquals(Charge.Geste.REDEMARRER, Charge.decider(true, false, 40, 6 * MIN, false, 3 * H, false));
    }

    @Test
    public void reglageRefuseOnNeLeRetentePasAvantUneDemiHeure() {
        assertEquals(Charge.Geste.RIEN, Charge.decider(true, false, 55, 10 * MIN, true, JAMAIS, false));
        assertEquals(Charge.Geste.REGLAGE, Charge.decider(true, false, 55, 31 * MIN, true, JAMAIS, false));
    }
}
