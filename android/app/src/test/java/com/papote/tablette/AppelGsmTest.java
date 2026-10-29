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

    private static JSONObject etat(String e) throws Exception {
        return new JSONObject().put("etat", e);
    }

    @Test
    public void laDestructionDeLAncienneActiviteNeCoupePasLaNouvelle() throws Exception {
        Object ancienne = new Object(), nouvelle = new Object();
        List<String> recuAncienne = new ArrayList<>(), recuNouvelle = new ArrayList<>();
        AppelGsm.ecouter(ancienne, (s) -> recuAncienne.add(s.optString("etat")));
        AppelGsm.simuler(etat("appel"));
        // Nouvelle activité créée : elle prend l'écoute et reçoit tout de suite l'état en cours.
        AppelGsm.ecouter(nouvelle, (s) -> recuNouvelle.add(s.optString("etat")));
        assertEquals(List.of("appel"), recuNouvelle);
        // L'ancienne est détruite après coup : sans effet sur la nouvelle.
        AppelGsm.oublier(ancienne);
        AppelGsm.simuler(etat("enLigne"));
        AppelGsm.simuler(etat("fin"));
        assertEquals(List.of("appel", "enLigne", "fin"), recuNouvelle);
        assertEquals(List.of("appel"), recuAncienne);
        // La nouvelle détruite à son tour : plus personne n'écoute.
        AppelGsm.oublier(nouvelle);
        AppelGsm.simuler(etat("sonne"));
        assertEquals(3, recuNouvelle.size());
        AppelGsm.ecouter(null, null);
    }
}
