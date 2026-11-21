import java.util.Properties

plugins {
    id("com.android.application")
}

// Mini-appli « Papote Charge » (ESSAI, Tanguy 21/11) : elle ne sait faire qu'une chose, réécrire la limite de
// charge Blackview pour relancer la charge sans redémarrer la tablette. Android refuse cette écriture aux
// applis récentes et la tolère pour les applis déclarées « anciennes » : d'où targetSdk 22, volontairement.
// Conséquence : seul le PC peut l'installer (adb install --bypass-low-target-sdk-block sur Android 14+).
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.papote.charge"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.papote.charge"
        minSdk = 21
        //noinspection ExpiredTargetSdkVersion
        targetSdk = 22
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("release") {
                // Même clé que Papote ; chemin lu comme dans app/ (relatif à android/app).
                storeFile = rootProject.file("app").resolve(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (signingProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Le vieux targetSdk est le but même de cette mini-appli.
        disable += setOf("ExpiredTargetSdkVersion", "OldTargetApi")
        checkReleaseBuilds = false
    }
}
