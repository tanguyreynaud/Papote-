import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// Clé de signature hors du dépôt (voir telephone/README.md).
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Identifiants Firebase de l'app Android : app/google-services.json, téléchargé depuis la console
// Firebase et gardé hors du dépôt. On en tire les valeurs que Firebase lit au démarrage
// (même résultat que le plugin google-services, sans dépendre de sa compatibilité avec AGP).
@Suppress("UNCHECKED_CAST")
val firebaseValues: Map<String, String> = run {
    val f = file("google-services.json")
    if (!f.exists()) return@run emptyMap()
    val json = JsonSlurper().parse(f) as Map<String, Any?>
    val projet = json["project_info"] as Map<String, Any?>
    val clients = json["client"] as List<Map<String, Any?>>
    val client = clients.first {
        val info = it["client_info"] as Map<String, Any?>
        val android = info["android_client_info"] as Map<String, Any?>
        android["package_name"] == "fr.mapapote.famille"
    }
    val info = client["client_info"] as Map<String, Any?>
    val cles = client["api_key"] as List<Map<String, Any?>>
    mapOf(
        "google_app_id" to info["mobilesdk_app_id"] as String,
        "gcm_defaultSenderId" to projet["project_number"] as String,
        "project_id" to projet["project_id"] as String,
        "google_api_key" to cles.first()["current_key"] as String,
        "google_storage_bucket" to (projet["storage_bucket"] as String? ?: ""),
    )
}

android {
    namespace = "fr.mapapote.famille"
    compileSdk = 36

    defaultConfig {
        applicationId = "fr.mapapote.famille"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        firebaseValues.forEach { (k, v) -> resValue("string", k, v) }
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

    // Valeurs Firebase ci-dessus (désactivé par défaut depuis AGP 9)
    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

gradle.taskGraph.whenReady {
    val construit = allTasks.any { it.name.startsWith("assemble") || it.name.startsWith("bundle") }
    if (construit && firebaseValues.isEmpty()) {
        throw GradleException("telephone/app/google-services.json manquant : voir telephone/README.md")
    }
}

dependencies {
    // Ouvre app.mapapote.fr dans Chrome, plein écran (Trusted Web Activity)
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    // Reçoit « Mamie vous appelle » même téléphone en veille
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("androidx.core:core:1.13.1")
}
