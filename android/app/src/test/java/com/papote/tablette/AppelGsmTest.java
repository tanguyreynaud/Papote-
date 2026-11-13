package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Deux MainActivity coexistent un instant après une mise à jour ou une relance du kiosque :
 * l'ancienne est détruite APRÈS la création de la nouvelle. Sa destruction ne doit pas couper
 * les états GSM de la nouvelle (bug du 29/10 : « Appel vers Tanguy… » restait affiché).
 */
public class AppelGsmTest {

    // Sous JUnit, org.json est la version vide d'Android (put ne garde rien) : on compare les objets
    // eux-mêmes, pas leur contenu.
    private static final JSONObject APPEL = new JSONObject(), EN_LIGNE = new JSONObject(),
            FIN = new JSONObject(), SONNE = new JSONObject();

    @Test
    public void laDestructionDeLAncienneActiviteNeCoupePasLaNouvelle() {
        Object ancienne = new Object(), nouvelle = new Object();
        List<JSONObject> recuAncienne = new ArrayList<>(), recuNouvelle = new ArrayList<>();
        AppelGsm.ecouter(ancienne, (s) -> recuAncienne.add(s));
        AppelGsm.simuler(APPEL);
        // Nouvelle activité créée : elle prend l'écoute et reçoit tout de suite l'état en cours.
        AppelGsm.ecouter(nouvelle, (s) -> recuNouvelle.add(s));
        assertEquals(List.of(APPEL), recuNouvelle);
        // L'ancienne est détruite après coup : sans effet sur la nouvelle.
        AppelGsm.oublier(ancienne);
        AppelGsm.simuler(EN_LIGNE);
        AppelGsm.simuler(FIN);
        assertEquals(List.of(APPEL, EN_LIGNE, FIN), recuNouvelle);
        assertEquals(List.of(APPEL), recuAncienne);
        // La nouvelle détruite à son tour : plus personne n'écoute.
        AppelGsm.oublier(nouvelle);
        AppelGsm.simuler(SONNE);
        assertEquals(3, recuNouvelle.size());
        AppelGsm.ecouter(null, null);
    }

    // T-003, 13/11 : une ligne ne doit jamais rester ouverte après « Raccrocher ».
    @Test
    public void unAppelQuiNEstNiFiniNiEnTrainDeFinirEstEncoreOuvert() {
        org.junit.Assert.assertTrue(AppelGsm.encoreOuvert(android.telecom.Call.STATE_ACTIVE));
        org.junit.Assert.assertTrue(AppelGsm.encoreOuvert(android.telecom.Call.STATE_HOLDING));
        org.junit.Assert.assertTrue(AppelGsm.encoreOuvert(android.telecom.Call.STATE_RINGING));
        org.junit.Assert.assertFalse(AppelGsm.encoreOuvert(android.telecom.Call.STATE_DISCONNECTING));
        org.junit.Assert.assertFalse(AppelGsm.encoreOuvert(android.telecom.Call.STATE_DISCONNECTED));
    }

    // T-003, 13/11 : raccroché puis rappel aussitôt, le « fin » tardif de l'ancien appel fermait l'écran du nouveau.
    @Test
    public void seulLAppelLePlusRecentMetLEcranAJour() {
        Object ancien = new Object(), nouveau = new Object();
        org.junit.Assert.assertTrue(AppelGsm.estLAppelSuivi(nouveau, nouveau));
        org.junit.Assert.assertFalse("ancien appel remplacé : ignoré", AppelGsm.estLAppelSuivi(ancien, nouveau));
        org.junit.Assert.assertFalse("plus d'appel suivi : ignoré", AppelGsm.estLAppelSuivi(ancien, null));
    }
}