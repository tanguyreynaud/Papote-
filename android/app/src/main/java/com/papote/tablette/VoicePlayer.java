package com.papote.tablette;

import android.content.Context;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.util.Log;

import java.io.File;

/**
 * Lecture des messages vocaux par Android plutôt que par la page :
 * sur Android 4.4, le lecteur du navigateur ne sait pas lire les fichiers servis localement.
 */
final class VoicePlayer {
    interface Listener {
        void onVoiceEnded();
    }

    private final Context context;
    private final Listener listener;
    private MediaPlayer player;

    VoicePlayer(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /** url : adresse locale d'un média (LocalContent.mediaUrl). */
    void play(String url) {
        stop();
        String name = Uri.parse(url).getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..")) return;
        File file = new File(new File(context.getFilesDir(), "photos"), name);
        if (!file.exists()) return;
        try {
            player = new MediaPlayer();
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(mp -> {
                stop();
                listener.onVoiceEnded();
            });
            player.prepare();
            player.start();
        } catch (Exception e) {
            Log.w("Papote", "Lecture du vocal", e);
            stop();
            listener.onVoiceEnded();
        }
    }

    void stop() {
        if (player == null) return;
        try { player.stop(); } catch (Exception ignored) { }
        player.release();
        player = null;
    }
}
