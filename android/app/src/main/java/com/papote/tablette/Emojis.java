package com.papote.tablette;

/**
 * Les emojis restent à l'écran, mais la voix ne les lit pas (Tanguy, 07/11) : la voix d'Android, utilisée
 * quand le MP3 du serveur manque, disait « visage souriant » ou « cœur rouge » au milieu du message.
 */
final class Emojis {
    private Emojis() { }

    static String sans(String texte) {
        if (texte == null) return null;
        StringBuilder sb = new StringBuilder(texte.length());
        int i = 0;
        while (i < texte.length()) {
            int c = texte.codePointAt(i);
            i += Character.charCount(c);
            if (estEmoji(c)) continue;
            sb.appendCodePoint(c);
        }
        // Espaces laissés par les emojis retirés (« Bisous ❤️ ! » → « Bisous ! », « ça ❤️, » → « ça, ») ;
        // l'espace français avant ! ? ; : est gardé.
        return sb.toString().replaceAll("[ \t]{2,}", " ").replaceAll(" +([,.])", "$1").trim();
    }

    static boolean estEmoji(int c) {
        return (c >= 0x1F000 && c <= 0x1FAFF)   // visages, gestes, objets, drapeaux, teintes de peau
                || (c >= 0x2600 && c <= 0x27BF)  // symboles divers et dingbats (☀ ❤ ✨ ✅)
                || (c >= 0x2B00 && c <= 0x2BFF)  // flèches et étoiles (⭐ ⬆)
                || (c >= 0x2300 && c <= 0x23FF && c != 0x2302) // ⌚ ⏰ ⌛
                || c == 0x200D                   // liant des familles (👨‍👩‍👧)
                || c == 0xFE0F || c == 0xFE0E    // variantes « emoji » / « texte »
                || c == 0x20E3                   // touche (1️⃣)
                || (c >= 0xE0020 && c <= 0xE007F) // étiquettes des drapeaux régionaux
                || c == 0x3030 || c == 0x303D;
    }
}
