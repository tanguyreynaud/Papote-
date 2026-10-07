import java.util.Properties

plugins {
    id("com.android.application")
}

// Clé de signature hors du dépôt (voir android/README.md).
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.papote.tablette"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.papote.tablette"
        minSdk = 19
        targetSdk = 36
        versionCode = 6
        versionName = "1.5"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
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
}

dependencies {
    // Chiffrement à jour sur Android 4.4 (ProviderInstaller) ; la version 17.x reste compatible Android 4.4.
    implementation("com.google.android.gms:play-services-basement:17.6.0")
}
