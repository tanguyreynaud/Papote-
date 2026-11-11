package android.os;

/** Horloge d'Android depuis l'allumage, imitée : le temps écoulé depuis le lancement de l'essai. */
public final class SystemClock {
    private static final long DEPART = System.nanoTime();
    public static long elapsedRealtime() { return (System.nanoTime() - DEPART) / 1_000_000L + 3_600_000L; }
    public static long uptimeMillis() { return elapsedRealtime(); }
    public static long elapsedRealtimeNanos() { return elapsedRealtime() * 1_000_000L; }
    public static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
    private SystemClock() { }
}
