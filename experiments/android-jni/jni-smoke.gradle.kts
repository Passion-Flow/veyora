val requiredGradle = "9.5.0"
val requiredJdk = 17
val requiredNdk = "28.2.13676358"
val requiredCompileSdk = 36
val requiredMinSdk = 28

tasks.register("verifyVeyoraAndroidPins") {
    doLast {
        check(gradle.gradleVersion == requiredGradle) { "PM-ANDROID-GRADLE-PIN" }
        check(JavaVersion.current().majorVersion.toInt() == requiredJdk) {
            "PM-ANDROID-JDK-PIN"
        }
        check(requiredNdk == "28.2.13676358") { "PM-ANDROID-NDK-PIN" }
        check(requiredCompileSdk == 36 && requiredMinSdk == 28) { "PM-ANDROID-SDK-PIN" }
    }
}
