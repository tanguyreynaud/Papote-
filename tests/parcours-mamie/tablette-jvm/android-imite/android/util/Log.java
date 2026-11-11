package android.util;

/** Journal d'Android, imité pour l'essai sur l'ordinateur : les lignes vont dans la sortie de l'essai. */
public final class Log {
    public static final int VERBOSE = 2, DEBUG = 3, INFO = 4, WARN = 5, ERROR = 6, ASSERT = 7;
    /** Lignes « w » et « e » gardées (les 500 dernières), relues par le banc quand un scénario échoue. */
    public static final java.util.List<String> lignes = java.util.Collections.synchronizedList(new java.util.ArrayList<>());

    private static int ecrire(String niveau, String tag, String msg, Throwable t) {
        String ligne = niveau + "/" + tag + ": " + msg + (t == null ? "" : " — " + t);
        if (!"V".equals(niveau) && !"D".equals(niveau)) {
            lignes.add(ligne);
            while (lignes.size() > 500) lignes.remove(0);
        }
        if (Boolean.getBoolean("pont.bavard")) System.err.println(ligne);
        return 0;
    }

    public static int v(String tag, String msg) { return ecrire("V", tag, msg, null); }
    public static int v(String tag, String msg, Throwable t) { return ecrire("V", tag, msg, t); }
    public static int d(String tag, String msg) { return ecrire("D", tag, msg, null); }
    public static int d(String tag, String msg, Throwable t) { return ecrire("D", tag, msg, t); }
    public static int i(String tag, String msg) { return ecrire("I", tag, msg, null); }
    public static int i(String tag, String msg, Throwable t) { return ecrire("I", tag, msg, t); }
    public static int w(String tag, String msg) { return ecrire("W", tag, msg, null); }
    public static int w(String tag, String msg, Throwable t) { return ecrire("W", tag, msg, t); }
    public static int w(String tag, Throwable t) { return ecrire("W", tag, "", t); }
    public static int e(String tag, String msg) { return ecrire("E", tag, msg, null); }
    public static int e(String tag, String msg, Throwable t) { return ecrire("E", tag, msg, t); }
    public static int wtf(String tag, String msg) { return ecrire("E", tag, msg, null); }
    public static int wtf(String tag, String msg, Throwable t) { return ecrire("E", tag, msg, t); }
    public static boolean isLoggable(String tag, int level) { return true; }
    public static String getStackTraceString(Throwable t) {
        if (t == null) return "";
        java.io.StringWriter w = new java.io.StringWriter();
        t.printStackTrace(new java.io.PrintWriter(w));
        return w.toString();
    }

    private Log() { }
}
