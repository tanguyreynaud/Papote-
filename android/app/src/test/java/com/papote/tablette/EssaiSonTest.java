package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** Essais du son de l'app famille (« Écouter ») : un seul son à la fois, jamais deux qui se chevauchent. */
public class EssaiSonTest {

    /** Fausse tablette : compte les sons qui jouent, horloge à la main. */
    private static final class Tablette implements EssaiSon.Sortie {
        boolean sonne;
        boolean parle;
        int maxEnMemeTemps;
        final List<String> journal = new ArrayList<>();
        final Map<Runnable, Long> minuteries = new LinkedHashMap<>();
        long maintenant;

        private void verifier() {
            maxEnMemeTemps = Math.max(maxEnMemeTemps, (sonne ? 1 : 0) + (parle ? 1 : 0));
        }
        @Override public void volume(String quoi, int pourcent) { journal.add("volume " + quoi + " " + pourcent); }
        @Override public void sonnerie(boolean on) { sonne = on; journal.add(on ? "sonne" : "sonnerie coupée"); verifier(); }
        @Override public void parler(String texte) { parle = true; journal.add("dit " + texte); verifier(); }
        @Override public void taire() { if (parle) journal.add("voix coupée"); parle = false; }
        @Override public void plusTard(Runnable r, long ms) { minuteries.put(r, maintenant + ms); }
        @Override public void annuler(Runnable r) { minuteries.remove(r); }

        void avancer(long ms) {
            maintenant += ms;
            for (Map.Entry<Runnable, Long> e : new ArrayList<>(minuteries.entrySet())) {
                if (e.getValue() <= maintenant && minuteries.remove(e.getKey()) != null) e.getKey().run();
            }
        }
    }

    @Test
    public void unEssaiCoupeLeSonEnCours() {
        Tablette t = new Tablette();
        EssaiSon e = new EssaiSon(t);
        e.jouer("sonnerie", 70, "");
        t.avancer(1_000);
        e.jouer("voix", 50, "Bonjour Mamie");
        assertEquals("la sonnerie ne continue pas sous la voix", false, t.sonne);
        e.jouer("appel", 80, "Vous m'entendez bien ?");
        e.jouer("sonnerie", 60, "");
        assertEquals(false, t.parle);
        e.jouer("voix", 40, "");
        assertEquals(false, t.sonne);
        assertEquals("jamais deux sons en même temps", 1, t.maxEnMemeTemps);
    }

    @Test
    public void lAncienneFinDeSonnerieNeCoupePasLaNouvelle() {
        Tablette t = new Tablette();
        EssaiSon e = new EssaiSon(t);
        e.jouer("sonnerie", 70, "");
        t.avancer(2_000);
        e.jouer("sonnerie", 90, "");
        t.avancer(1_500); // 3,5 s après le premier essai : sa fin ne compte plus
        assertTrue("la deuxième sonnerie joue encore", t.sonne);
        t.avancer(1_500);
        assertEquals("elle s'arrête 3 s après son début", false, t.sonne);
    }

    @Test
    public void laSonnerieDEssaiSArreteSeuleApresTroisSecondes() {
        Tablette t = new Tablette();
        new EssaiSon(t).jouer("sonnerie", 70, "");
        t.avancer(EssaiSon.SONNERIE_MS - 1);
        assertTrue(t.sonne);
        t.avancer(1);
        assertEquals(false, t.sonne);
    }

    @Test
    public void unVraiAppelPendantLEssaiNEstPasCoupe() {
        Tablette t = new Tablette();
        EssaiSon e = new EssaiSon(t);
        e.jouer("sonnerie", 70, "");
        e.appelReel(); // la page fait sonner pour un vrai appel : CallAudio garde la sonnerie qui joue
        t.avancer(10_000);
        assertTrue("la sonnerie du vrai appel continue", t.sonne);
    }

    @Test
    public void volumesEtPhrases() {
        Tablette t = new Tablette();
        EssaiSon e = new EssaiSon(t);
        e.jouer("appel", 5, "  ");
        e.jouer("autre chose", 150, "Bonjour");
        assertEquals(List.of("volume appel 10", "dit " + EssaiSon.PHRASE, "voix coupée", "volume voix 100", "dit Bonjour"), t.journal);
        assertEquals("sonnerie", EssaiSon.quoi("sonnerie"));
        assertEquals("appel", EssaiSon.quoi("appel"));
        assertEquals("voix", EssaiSon.quoi(null));
    }
}
