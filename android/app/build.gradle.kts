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
        minSdk = 28
        targetSdk = 36
        versionCode = 43
        versionName = "2.35"
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
    // QR code d'invitation affiché sur la tablette
    implementation("com.google.zxing:core:3.5.3")
}
