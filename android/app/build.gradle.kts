import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// Clé de signature hors du dépôt (voir android/README.md).
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Identifiants Firebase de la tablette (notifications push qui la réveillent : voir Push.java) :
// app/google-services.json, téléchargé depuis la console Firebase (app Android com.papote.tablette)
// et gardé hors du dépôt. Même lecture que telephone/ : les valeurs que Firebase lit au démarrage,
// sans le plugin google-services. SANS le fichier, la tablette se construit quand même, sans push
// (la page garde alors son écoute en direct).
@Suppress("UNCHECKED_CAST")
val firebaseValues: Map<String, String> = run {
    val f = file("google-services.json")
    if (!f.exists()) return@run emptyMap()
    val json = JsonSlurper().parse(f) as Map<String, Any?>
    val projet = json["project_info"] as Map<String, Any?>
    val clients = json["client"] as List<Map<String, Any?>>
    val client = clients.firstOrNull {
        val info = it["client_info"] as Map<String, Any?>
        val android = info["android_client_info"] as Map<String, Any?>
        android["package_name"] == "com.papote.tablette"
    } ?: return@run emptyMap()
    val info = client["client_info"] as Map<String, Any?>
    val cles = client["api_key"] as List<Map<String, Any?>>
    mapOf(
        "google_app_id" to info["mobilesdk_app_id"] as String,
        "gcm_defaultSenderId" to projet["project_number"] as String,
        "project_id" to projet["project_id"] as String,
        "google_api_key" to cles.first()["current_key"] as String,
    )
}

android {
    namespace = "com.papote.tablette"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.papote.tablette"
        minSdk = 28
        targetSdk = 36
        versionCode = 192
        versionName = "2.99.85"
        firebaseValues.forEach { (k, v) -> resValue("string", k, v) }
    }

    buildFeatures {
        resValues = true
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

    // Petits essais sur l'ordinateur (gradlew test) : Android y est imité, sans tablette.
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // QR code d'invitation affiché sur la tablette
    implementation("com.google.zxing:core:3.5.3")
    // Notifications push du serveur (réveil de la tablette sans écoute ouverte en permanence)
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    testImplementation("junit:junit:4.13.2")
}
