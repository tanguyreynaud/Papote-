package android.os;

import java.util.concurrent.ScheduledThreadPoolExecutor;

/** File de travail d'un fil Android, imitée par un fil Java qui exécute les tâches une par une. */
public final class Looper {
    final ScheduledThreadPoolExecutor fil;
    private static Looper principal;

    Looper(String nom) {
        fil = new ScheduledThreadPoolExecutor(1, (r) -> { Thread t = new Thread(r, nom); t.setDaemon(true); return t; });
        fil.setRemoveOnCancelPolicy(true);
    }

    public static synchronized Looper getMainLooper() {
        if (principal == null) principal = new Looper("principal");
        return principal;
    }
    public static Looper myLooper() { return getMainLooper(); }
    public static void prepare() { }
    public static void loop() { }
    public Thread getThread() { return Thread.currentThread(); }
    public void quit() { fil.shutdownNow(); }
    public void quitSafely() { fil.shutdown(); }
}
