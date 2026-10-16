package com.papote.tablette;

import android.content.Context;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.PowerManager;
import android.util.Log;

/** Sonnerie d'appel entrant et son en haut-parleur pendant un appel vidéo. */
final class CallAudio {
    private static final String TAG = "Papote";

    private final Context context;
    private MediaPlayer ringer;
    private PowerManager.WakeLock wakeLock;
    private int previousMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeaker;

    CallAudio(Context context) {
        this.context = context.getApplicationContext();
    }

    @SuppressWarnings("deprecation")
    void ring(boolean on) {
        stopRinging();
        if (!on) return;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP, "papote:appel");
            wakeLock.acquire(60_000);
        } catch (Exception e) {
            Log.w(TAG, "Réveil de l'écran", e);
        }
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringer = new MediaPlayer();
            ringer.setDataSource(context, uri);
            ringer.setAudioStreamType(AudioManager.STREAM_RING);
            ringer.setLooping(true);
            ringer.prepare();
            ringer.start();
        } catch (Exception e) {
            Log.w(TAG, "Sonnerie", e);
            stopRinging();
        }
    }

    private void stopRinging() {
        if (ringer != null) {
            try { ringer.stop(); } catch (Exception ignored) { }
            ringer.release();
            ringer = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    /** Pendant l'appel : mode communication (annulation d'écho) et haut-parleur. */
    void inCall(boolean on) {
        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (on) {
            previousMode = am.getMode();
            previousSpeaker = am.isSpeakerphoneOn();
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(true);
        } else {
            am.setMode(previousMode);
            am.setSpeakerphoneOn(previousSpeaker);
        }
    }

    void release() {
        stopRinging();
    }
}
