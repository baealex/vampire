import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { configuredToken } from './runtime-config.ts';
import { configureSessionAuthentication } from './session-cookie.ts';

const TOKEN_KEY_BYTES = 32;
const TOKEN_SALT_BYTES = 16;
const AUTHENTICATION_STATE_KEY = '__vampireTokenVerifierV2' as const;
const SCRYPT_OPTIONS = {
  N: 2 ** 15,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024,
} as const;

interface AuthenticationState {
  initialized: boolean;
  salt?: Buffer;
  verifier?: Buffer;
  verificationInFlight: boolean;
}

interface AuthenticationRuntimeGlobal {
  [AUTHENTICATION_STATE_KEY]?: AuthenticationState;
}

function authenticationState(): AuthenticationState {
  const runtimeGlobal = globalThis as typeof globalThis & AuthenticationRuntimeGlobal;
  runtimeGlobal[AUTHENTICATION_STATE_KEY] ??= {
    initialized: false,
    verificationInFlight: false,
  };
  return runtimeGlobal[AUTHENTICATION_STATE_KEY];
}

function deriveTokenKey(token: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(token, salt, TOKEN_KEY_BYTES, SCRYPT_OPTIONS, (cause, derivedKey) => {
      if (cause) reject(cause);
      else resolve(derivedKey);
    });
  });
}

export async function initializeAuthentication(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = configuredToken(env);
  delete env.VAMPIRE_TOKEN;

  const runtime = authenticationState();
  runtime.initialized = false;
  runtime.salt?.fill(0);
  runtime.verifier?.fill(0);
  runtime.salt = undefined;
  runtime.verifier = undefined;
  runtime.verificationInFlight = false;
  configureSessionAuthentication(true);

  if (!token) {
    runtime.initialized = true;
    configureSessionAuthentication(false);
    return;
  }

  const salt = randomBytes(TOKEN_SALT_BYTES);
  const verifier = await deriveTokenKey(token, salt);
  runtime.salt = salt;
  runtime.verifier = verifier;
  runtime.initialized = true;
  configureSessionAuthentication(true);
}

export async function verifyConfiguredToken(token: string): Promise<boolean | undefined> {
  const runtime = authenticationState();
  if (!runtime.initialized || !runtime.salt || !runtime.verifier) return false;
  if (runtime.verificationInFlight) return undefined;

  runtime.verificationInFlight = true;
  try {
    const candidate = await deriveTokenKey(token, runtime.salt);
    try {
      return timingSafeEqual(candidate, runtime.verifier);
    } finally {
      candidate.fill(0);
    }
  } finally {
    runtime.verificationInFlight = false;
  }
}
