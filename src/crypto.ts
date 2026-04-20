/**
 * Token Encryption/Decryption — Node.js implementation
 *
 * MUST match exactly the Deno implementation in
 *   supabase/functions/_shared/token-crypto.ts
 *
 * Algorithm:
 *   - AES-GCM 256
 *   - PBKDF2 with SHA-256, 100k iterations, salt "dmcraft-oauth-v1"
 *   - Prefix "enc:" + base64(iv[12 bytes] || ciphertext+tag)
 *   - Plaintext (no prefix) is returned as-is for backward compatibility
 */

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const ENC_PREFIX = "enc:";
const SALT = "dmcraft-oauth-v1";
const ITERATIONS = 100_000;

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(SALT),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(plaintext: string): Promise<string> {
  const secret = (process.env.OAUTH_ENCRYPTION_KEY || "").trim();
  if (!secret) {
    return plaintext;
  }

  const key = await deriveKey(secret);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  const ctBytes = new Uint8Array(ciphertext);
  const combined = new Uint8Array(iv.length + ctBytes.length);
  combined.set(iv, 0);
  combined.set(ctBytes, iv.length);

  return ENC_PREFIX + Buffer.from(combined).toString("base64");
}

export async function decryptToken(stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored;
  }

  const secret = (process.env.OAUTH_ENCRYPTION_KEY || "").trim();
  if (!secret) {
    throw new Error("OAUTH_ENCRYPTION_KEY not configured but token is encrypted");
  }

  const b64 = stored.slice(ENC_PREFIX.length);
  const combined = new Uint8Array(Buffer.from(b64, "base64"));

  if (combined.length < 13) {
    throw new Error("Invalid encrypted token: payload too short");
  }

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const key = await deriveKey(secret);
  const decrypted = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
