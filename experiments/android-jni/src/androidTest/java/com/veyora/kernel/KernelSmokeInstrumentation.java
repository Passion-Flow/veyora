package com.veyora.kernel;

import android.test.InstrumentationTestCase;

@SuppressWarnings("deprecation")
public final class KernelSmokeInstrumentation extends InstrumentationTestCase {
    public void testStatusOnlyJniSmoke() {
        assertEquals(0, KernelSmoke.statusOnlySmoke());
    }
}
