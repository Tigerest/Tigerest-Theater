plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
// MAJOR.MINOR.PATCH, plus a fourth number (1-99) for an Android-only fix such as 2.9.5.1.
val appVersion = "2.9.5"
val versionParts = appVersion.split('.').map(String::toInt)
check(versionParts.size in 3..4 && versionParts.drop(1).take(2).all { it in 0..99 } && versionParts.getOrElse(3) { 1 } in 1..99) { "Invalid app version $appVersion" }
// The commit this build comes from, shown with the version on the update page.
val gitRevision = runCatching {
    providers.exec { commandLine("git", "rev-parse", "--short=8", "HEAD"); isIgnoreExitValue = true }.standardOutput.asText.get().trim()
}.getOrDefault("").takeIf { it.matches(Regex("[0-9a-f]+")) } ?: ""
android {
    namespace = "top.tigerest.theater"
    compileSdk = 36
    defaultConfig {
        applicationId = "top.tigerest.theater"
        minSdk = 35
        targetSdk = 36
        // Two digits for each number after the first: 2.9.5 is 2090500, 2.9.5.1 is 2090501.
        versionCode = versionParts[0] * 1_000_000 + versionParts[1] * 10_000 + versionParts[2] * 100 + versionParts.getOrElse(3) { 0 }
        versionName = appVersion
        buildConfigField("String", "GIT_REVISION", "\"$gitRevision\"")
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; resValue("string","app_name","大河影院（调试）") }
        release { isMinifyEnabled = false; resValue("string","app_name","大河影院") }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true }
    packaging { jniLibs { useLegacyPackaging = false } }
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
val sharedAssets = tasks.register<Copy>("syncSharedWebAssets") {
    from(rootProject.file("../native")) { include("*.js", "*.css", "*.html", "*.png", "home-art/*.png") }
    from(rootProject.file("../resources/settings/settings_description.json"))
    into("src/main/assets/shared")
}
tasks.named("preBuild") { dependsOn(sharedAssets) }
dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.window:window:1.4.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
