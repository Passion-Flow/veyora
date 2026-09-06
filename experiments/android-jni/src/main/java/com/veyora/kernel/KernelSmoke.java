package com.veyora.kernel;

public final class KernelSmoke {
    static {
        System.loadLibrary("kernel_ffi");
    }

    private KernelSmoke() {}

    public static native int statusOnlySmoke();
}
