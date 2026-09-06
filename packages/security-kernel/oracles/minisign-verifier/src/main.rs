use minisign_verify::{PublicKey, Signature};
use std::path::Path;

const LIBSODIUM_MINISIGN_PUBLIC_KEY: &str =
    "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let artifact = arguments.next().ok_or("missing artifact")?;
    let signature_path = arguments.next().ok_or("missing signature")?;
    if arguments.next().is_some() {
        return Err("unexpected argument".into());
    }

    let public_key = PublicKey::from_base64(LIBSODIUM_MINISIGN_PUBLIC_KEY)?;
    let signature = Signature::from_file(Path::new(&signature_path))?;
    let contents = std::fs::read(artifact)?;
    public_key.verify(&contents, &signature, false)?;
    println!("minisign-verification: PASS");
    Ok(())
}
