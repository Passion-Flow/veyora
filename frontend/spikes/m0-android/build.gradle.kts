plugins {
    id("com.android.application") version "9.3.1"
}

apply(from = "jni-smoke.gradle.kts")

val veyoraJniLibDir = providers.gradleProperty("veyoraJniLibDir")

android {
    namespace = "com.veyora.kernel"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.veyora.kernel.smoke"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }

    sourceSets.getByName("main") {
        jniLibs.srcDir(veyoraJniLibDir.get())
    }
}
