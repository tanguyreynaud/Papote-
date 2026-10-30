# Règles de compression (R8) de l'appli tablette.

# Ponts appelés par la page (window.PapoteAndroid.*) : R8 ne voit pas ces appels et les supprimerait
# ou les renommerait. Sans cette règle, la page ne parle plus à Android.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Les noms des classes et méthodes restent lisibles dans le journal (« PLANTAGE : … ») envoyé à la famille.
-dontobfuscate
-keepattributes SourceFile,LineNumberTable
