package com.papote.tablette;

import android.media.MediaPlayer;
import android.media.audiofx.LoudnessEnhancer;
import android.util.Log;

/**
 * Son plus fort que le maximum d'Android pour les vidéos, les vocaux et le carillon (Tanguy, 29/10 :
 * « mieux vaut que 100 % soit trop fort et qu'on baisse »). LoudnessEnhancer d'Android, qui limite
 * lui-même les pointes : le son monte sans grésiller. Pas pour les appels : l'annulation d'écho ne
 * suivrait plus (larsen).
 */
final class Renfort {
    /** +6 dB, environ deux fois plus fort. */
    static final int GAIN_MB = 600;

    private LoudnessEnhancer effet;

    void sur(MediaPlayer mp) {
        arreter();
        try {
            effet = new LoudnessEnhancer(mp.getAudioSessionId());
            effet.setTargetGain(GAIN_MB);
            effet.setEnabled(true);
        } catch (Exception e) {
            Log.w("Papote", "Renfort du son", e);
            effet = null;
        }
    }

    void arreter() {
        if (effet == null) return;
        try { effet.release(); } catch (Exception ignored) { }
        effet = null;
    }
}
