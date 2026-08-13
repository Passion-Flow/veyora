use std::{fs, path::Path};

fn project_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
}

#[test]
fn android_arm64_harness_is_real_status_only_and_exactly_pinned() {
    let spike = project_root().join("frontend/spikes/m0-android");
    let build = fs::read_to_string(spike.join("build.gradle.kts")).unwrap();
    assert!(build.contains("com.android.application\") version \"9.3.1"));
    assert!(build.contains("compileSdk = 36"));
    assert!(build.contains("buildToolsVersion = \"36.0.0\""));
    assert!(build.contains("ndkVersion = \"28.2.13676358\""));
    assert!(build.contains("minSdk = 28"));
    assert!(build.contains("targetSdk = 36"));
    assert!(build.contains("android.test.InstrumentationTestRunner"));

    let java =
        fs::read_to_string(spike.join("src/main/java/com/veyora/kernel/KernelSmoke.java")).unwrap();
    assert!(java.contains("System.loadLibrary(\"kernel_ffi\")"));
    assert!(java.contains("native int statusOnlySmoke()"));

    let instrumentation = fs::read_to_string(
        spike.join("src/androidTest/java/com/veyora/kernel/KernelSmokeInstrumentation.java"),
    )
    .unwrap();
    assert!(instrumentation.contains("extends InstrumentationTestCase"));
    assert!(instrumentation.contains("KernelSmoke.statusOnlySmoke()"));

    let script =
        fs::read_to_string(project_root().join("security-kernel/scripts/build-ffi.sh")).unwrap();
    assert!(script.contains("adb devices"));
    assert!(script.contains("ro.product.cpu.abi"));
    assert!(script.contains("arm64-v8a"));
    assert!(script.contains("connectedDebugAndroidTest"));
}
