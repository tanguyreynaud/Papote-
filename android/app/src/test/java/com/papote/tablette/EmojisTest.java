package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** La voix ne lit pas les emojis (gradlew test). */
public class EmojisTest {

    @Test
    public void emojisRetiresTexteGarde() {
        assertEquals("Bisous Mamie !", Emojis.sans("Bisous 👍❤️🎉 Mamie 👨‍👩‍👧 !"));
        assertEquals("Joyeux anniversaire", Emojis.sans("🎂 Joyeux anniversaire ✨"));
        assertEquals("À bientôt, on t'aime.", Emojis.sans("À bientôt 😘, on t'aime ❤️."));
        assertEquals("Il fait 20 °C à Nice", Emojis.sans("Il fait 20 °C à Nice ☀️"));
    }

    @Test
    public void textesSansEmojiInchanges() {
        assertEquals("Bonjour Mamie, ça va ?", Emojis.sans("Bonjour Mamie, ça va ?"));
        assertEquals("", Emojis.sans("👍"));
    }
}
