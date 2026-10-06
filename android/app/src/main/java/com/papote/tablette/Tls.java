package com.papote.tablette;

import android.content.Context;
import android.os.Build;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * HTTPS pour les vieilles tablettes (Android 4.4) : active TLS 1.2, désactivé par défaut,
 * et ajoute les autorités récentes (Google Trust Services, Let's Encrypt) absentes du système.
 */
final class Tls {
    private static SSLSocketFactory factory;

    private Tls() { }

    static synchronized SSLSocketFactory socketFactory(Context context) throws Exception {
        if (factory != null) return factory;
        installPlayServicesProvider(context);
        final X509TrustManager system = trustManager(null);
        final X509TrustManager bundled = trustManager(bundledRoots(context));
        X509TrustManager combined = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                system.checkClientTrusted(chain, authType);
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    system.checkServerTrusted(chain, authType);
                } catch (CertificateException e) {
                    bundled.checkServerTrusted(chain, authType);
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return system.getAcceptedIssuers();
            }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{combined}, null);
        factory = new ModernProtocols(ctx.getSocketFactory());
        return factory;
    }

    /**
     * Sur Android 4.4, le chiffrement du système ne connaît pas AES-GCM, exigé par certains serveurs
     * (la météo). Les services Google Play fournissent un module de chiffrement à jour.
     */
    private static void installPlayServicesProvider(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) return;
        try {
            com.google.android.gms.security.ProviderInstaller.installIfNeeded(context);
        } catch (Throwable e) {
            android.util.Log.w("Papote", "Module de chiffrement Play Services indisponible", e);
        }
    }

    private static KeyStore bundledRoots(Context context) throws Exception {
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        int[] roots = {R.raw.gts_root_r1, R.raw.gts_root_r4, R.raw.isrg_root_x1, R.raw.isrg_root_x2};
        for (int i = 0; i < roots.length; i++) {
            InputStream in = context.getResources().openRawResource(roots[i]);
            try {
                ks.setCertificateEntry("root" + i, cf.generateCertificate(in));
            } finally {
                in.close();
            }
        }
        return ks;
    }

    private static X509TrustManager trustManager(KeyStore ks) throws Exception {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        throw new IllegalStateException("Pas de X509TrustManager");
    }

    /** Active TLS 1.2 (et 1.1) sur les sockets quand le système le supporte sans l'activer. */
    private static final class ModernProtocols extends SSLSocketFactory {
        private final SSLSocketFactory base;

        ModernProtocols(SSLSocketFactory base) {
            this.base = base;
        }

        private Socket patch(Socket s) {
            if (s instanceof SSLSocket && Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                SSLSocket ssl = (SSLSocket) s;
                List<String> supported = Arrays.asList(ssl.getSupportedProtocols());
                List<String> wanted = new ArrayList<>();
                for (String p : new String[]{"TLSv1.2", "TLSv1.1", "TLSv1"}) {
                    if (supported.contains(p)) wanted.add(p);
                }
                ssl.setEnabledProtocols(wanted.toArray(new String[0]));
                // Les suites AES-GCM existent mais ne sont pas activées : beaucoup de serveurs n'acceptent qu'elles.
                List<String> suites = new ArrayList<>(Arrays.asList(ssl.getEnabledCipherSuites()));
                for (String c : ssl.getSupportedCipherSuites()) {
                    if (c.startsWith("TLS_ECDHE_") && c.contains("_GCM_") && !suites.contains(c)) suites.add(0, c);
                }
                ssl.setEnabledCipherSuites(suites.toArray(new String[0]));
            }
            return s;
        }

        @Override public String[] getDefaultCipherSuites() { return base.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return base.getSupportedCipherSuites(); }

        @Override
        public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
            return patch(base.createSocket(s, host, port, autoClose));
        }

        @Override
        public Socket createSocket(String host, int port) throws IOException {
            return patch(base.createSocket(host, port));
        }

        @Override
        public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            return patch(base.createSocket(host, port, localHost, localPort));
        }

        @Override
        public Socket createSocket(InetAddress host, int port) throws IOException {
            return patch(base.createSocket(host, port));
        }

        @Override
        public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            return patch(base.createSocket(address, port, localAddress, localPort));
        }
    }
}
