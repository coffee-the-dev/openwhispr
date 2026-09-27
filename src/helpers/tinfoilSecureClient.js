// Attested access to Tinfoil.
// The SDK's SecureClient verifies the enclave and pins the connection to the attested key;
// one client is held per session so attestation is paid once and shared by every caller.
let clientPromise = null;

function getSecureClient() {
  if (!clientPromise) {
    // ESM-only package, loaded from CommonJS.
    clientPromise = import("tinfoil").then(({ SecureClient }) => new SecureClient());
    // Don't cache a failed import — the next dictation should retry.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/** Fetches an enclave path over the attested transport. Needs no API key. */
async function tinfoilSecureFetch(path, init) {
  const client = await getSecureClient();
  return client.fetch(path, init);
}

module.exports = { tinfoilSecureFetch };
