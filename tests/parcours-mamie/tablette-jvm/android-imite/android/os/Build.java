package android.os;

/** Fiche de l'appareil, imitée : une Blackview Tab 60 Pro sous Android 15. */
public class Build {
    public static final String UNKNOWN = "unknown";
    public static String SERIAL = System.getProperty("pont.serie", "SERIEBANC0001");
    public static final String MODEL = "Tab 60 Pro";
    public static final String MANUFACTURER = "Blackview";
    public static final String BRAND = "Blackview";
    public static final String DEVICE = "Tab60Pro";
    public static final String PRODUCT = "Tab60Pro";
    public static final String DISPLAY = "banc";
    public static final String FINGERPRINT = "banc";
    public static String getSerial() { return SERIAL; }

    public static class VERSION {
        public static final int SDK_INT = 35;
        public static final String RELEASE = "15";
        public static final String SECURITY_PATCH = "2026-10-01";
    }

    public static class VERSION_CODES {
        public static final int N = 24, N_MR1 = 25, O = 26, O_MR1 = 27, P = 28, Q = 29, R = 30, S = 31, S_V2 = 32,
                TIRAMISU = 33, UPSIDE_DOWN_CAKE = 34, VANILLA_ICE_CREAM = 35, BAKLAVA = 36, M = 23, LOLLIPOP = 21, KITKAT = 19;
    }
}
