#[cfg(any(test, target_os = "android"))]
use kernel_core::KernelError;
#[cfg(any(test, target_os = "android"))]
use zeroize::{Zeroize, Zeroizing};

#[cfg(any(test, target_os = "android"))]
trait OutputReference {
    fn release(&mut self, wiped_output: &[u8; 32]);
}

#[cfg(any(test, target_os = "android"))]
struct FixedOutputGuard<R: OutputReference> {
    output: Box<Zeroizing<[u8; 32]>>,
    reference: R,
}

#[cfg(any(test, target_os = "android"))]
impl<R: OutputReference> FixedOutputGuard<R> {
    #[cfg(test)]
    fn new(output: [u8; 32], reference: R) -> Self {
        Self {
            output: Box::new(Zeroizing::new(output)),
            reference,
        }
    }

    #[cfg(target_os = "android")]
    fn from_boxed(output: Box<Zeroizing<[u8; 32]>>, reference: R) -> Self {
        Self { output, reference }
    }

    #[cfg(target_os = "android")]
    fn reference_mut(&mut self) -> &mut R {
        &mut self.reference
    }

    fn copy_if_exact(&self, written: Result<i32, ()>) -> Result<Zeroizing<[u8; 32]>, KernelError> {
        match written {
            Ok(32) => Ok(Zeroizing::new(**self.output)),
            Ok(_) | Err(()) => Err(KernelError::DeviceCredentialUnavailable),
        }
    }
}

#[cfg(any(test, target_os = "android"))]
impl<R: OutputReference> Drop for FixedOutputGuard<R> {
    fn drop(&mut self) {
        self.output.zeroize();
        self.reference.release(self.output.as_ref());
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::{FixedOutputGuard, OutputReference};
    use jni::{
        Env, EnvUnowned, JValue, jni_sig, jni_str,
        objects::{JByteBuffer, JClass, JObject},
        sys::jint,
    };
    use kernel_core::KernelError;
    use zeroize::Zeroizing;

    struct AndroidOutputReference<'env, 'local> {
        env: &'env mut Env<'local>,
        buffer: Option<JByteBuffer<'local>>,
    }

    impl<'env, 'local> AndroidOutputReference<'env, 'local> {
        fn call_cipher(
            &mut self,
            cipher: &JObject<'_>,
            encrypted_input: &JByteBuffer<'_>,
        ) -> Result<i32, ()> {
            let direct_buffer = self.buffer.as_ref().ok_or(())?;
            self.env
                .call_method(
                    cipher,
                    jni_str!("doFinal"),
                    jni_sig!("(Ljava/nio/ByteBuffer;Ljava/nio/ByteBuffer;)I"),
                    &[
                        JValue::Object(encrypted_input.as_ref()),
                        JValue::Object(direct_buffer.as_ref()),
                    ],
                )
                .and_then(|value| value.i())
                .map_err(|_| ())
        }
    }

    impl OutputReference for AndroidOutputReference<'_, '_> {
        fn release(&mut self, _wiped_output: &[u8; 32]) {
            if let Some(buffer) = self.buffer.take() {
                self.env.delete_local_ref(buffer);
            }
        }
    }

    /// Calls an already-initialized Android Keystore `Cipher.doFinal` using a
    /// single fixed Rust-owned direct output buffer. The private guard wipes
    /// the bytes before releasing the JNI local reference on every return path.
    ///
    /// # Safety boundary
    ///
    /// `Env::new_direct_byte_buffer` is the only unsafe operation. The pointer
    /// addresses a live fixed 32-byte Rust allocation for the entire Java call,
    /// the object never leaves this function, and the guard deletes the local
    /// reference only after wiping the backing allocation.
    pub fn unwrap_with_cipher<'local>(
        env: &mut Env<'local>,
        cipher: &JObject<'local>,
        encrypted_input: &JByteBuffer<'local>,
    ) -> Result<Zeroizing<[u8; 32]>, KernelError> {
        let mut output = Box::new(Zeroizing::new([0_u8; 32]));
        // SAFETY: the fixed allocation stays live and cannot resize or move
        // when its Box moves. The guard keeps it alive until after wiping the
        // bytes and deleting this local reference.
        let direct_buffer =
            unsafe { env.new_direct_byte_buffer(output.as_mut_ptr(), output.len()) }
                .map_err(|_| KernelError::DeviceCredentialUnavailable)?;

        let mut guard = FixedOutputGuard::from_boxed(
            output,
            AndroidOutputReference {
                env,
                buffer: Some(direct_buffer),
            },
        );
        let written = guard.reference_mut().call_cipher(cipher, encrypted_input);
        guard.copy_if_exact(written)
    }

    /// Status-only JNI load/call smoke used by the pinned arm64 instrumentation
    /// harness. It returns no secret-bearing data and exercises no Keystore API.
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_veyora_kernel_KernelSmoke_statusOnlySmoke<'local>(
        _env: EnvUnowned<'local>,
        _class: JClass<'local>,
    ) -> jint {
        0
    }
}

#[cfg(target_os = "android")]
pub use platform::unwrap_with_cipher;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[derive(Clone)]
    struct ReleaseProbe(Rc<RefCell<Option<bool>>>);

    impl OutputReference for ReleaseProbe {
        fn release(&mut self, output: &[u8; 32]) {
            *self.0.borrow_mut() = Some(output.iter().all(|byte| *byte == 0));
        }
    }

    #[test]
    fn fixed_output_wipes_before_reference_release_on_exact_error_short_and_long_results() {
        for (written, succeeds) in [
            (Ok(32), true),
            (Err(()), false),
            (Ok(31), false),
            (Ok(33), false),
        ] {
            let observation = Rc::new(RefCell::new(None));
            let result = {
                let guard =
                    FixedOutputGuard::new([0x5a; 32], ReleaseProbe(Rc::clone(&observation)));
                guard.copy_if_exact(written)
            };

            assert_eq!(result.is_ok(), succeeds, "written={written:?}");
            if let Ok(secret) = result {
                assert_eq!(secret.as_ref(), &[0x5a; 32]);
            }
            assert_eq!(*observation.borrow(), Some(true), "written={written:?}");
        }
    }
}
