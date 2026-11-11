package android.os;

/** Fil de travail d'Android, imité (voir Looper). */
public class HandlerThread {
    private final Looper looper;
    public HandlerThread(String nom) { looper = new Looper(nom); }
    public HandlerThread(String nom, int priorite) { this(nom); }
    public void start() { }
    public Looper getLooper() { return looper; }
    public boolean quit() { looper.quit(); return true; }
    public boolean quitSafely() { looper.quitSafely(); return true; }
}
