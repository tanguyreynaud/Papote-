package android.os;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Handler d'Android, imité : post, postDelayed, removeCallbacks sur le fil du Looper.
 * « acceleration » divise les délais (2 = deux fois plus vite), pour ne pas attendre 2 minutes entre deux tours.
 */
public class Handler {
    public static volatile double acceleration = 1;
    private final Looper looper;
    private final Map<Runnable, List<Future<?>>> prevus = new IdentityHashMap<>();

    public Handler() { this(Looper.getMainLooper()); }
    public Handler(Looper looper) { this.looper = looper == null ? Looper.getMainLooper() : looper; }
    public Looper getLooper() { return looper; }

    public final boolean post(Runnable r) { return postDelayed(r, 0); }
    public final boolean postAtFrontOfQueue(Runnable r) { return postDelayed(r, 0); }

    public final boolean postDelayed(Runnable r, long ms) {
        final Future<?>[] moi = new Future<?>[1];
        Runnable tache = () -> {
            synchronized (prevus) {
                List<Future<?>> l = prevus.get(r);
                if (l != null) { l.remove(moi[0]); if (l.isEmpty()) prevus.remove(r); }
            }
            try { r.run(); } catch (Throwable t) {
                android.util.Log.e("Handler", "tâche en échec (sur une vraie tablette : l'appli plante)", t);
                plantages.add(String.valueOf(t));
            }
        };
        try {
            synchronized (prevus) {
                moi[0] = looper.fil.schedule(tache, Math.max(0, (long) (ms / acceleration)), TimeUnit.MILLISECONDS);
                prevus.computeIfAbsent(r, (k) -> new ArrayList<>()).add(moi[0]);
            }
            return true;
        } catch (RejectedExecutionException e) {
            return false; // fil arrêté
        }
    }

    public final void removeCallbacks(Runnable r) {
        synchronized (prevus) {
            List<Future<?>> l = prevus.remove(r);
            if (l != null) for (Future<?> f : l) f.cancel(false);
        }
    }

    public final void removeCallbacksAndMessages(Object jeton) {
        synchronized (prevus) {
            for (List<Future<?>> l : prevus.values()) for (Future<?> f : l) f.cancel(false);
            prevus.clear();
        }
    }

    /** Exceptions sorties d'une tâche : sur une vraie tablette, chacune ferait planter l'appli. */
    public static final List<String> plantages = java.util.Collections.synchronizedList(new ArrayList<>());
}
