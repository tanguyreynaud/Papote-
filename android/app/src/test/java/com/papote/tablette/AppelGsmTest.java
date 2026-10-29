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
}
