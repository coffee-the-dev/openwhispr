const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

const MANAGED_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

function managedBedrockConfig() {
  return {
    workspaceId: "workspace-a",
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: "workspace:workspace-a",
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [
      {
        provider: "bedrock",
        mode: "managed_required",
        allowManualSetup: false,
        config: {
          roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
          region: "us-east-1",
          allowedModels: [MANAGED_MODEL],
          scopeDefaults: Object.fromEntries(SCOPES.map((scope) => [scope, MANAGED_MODEL])),
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

// Regression: a self-hosted endpoint left over from before the administrator enabled managed
// access used to win the route, so prompts left through the employee's own server while the UI
// reported "Managed by your organization" — silently defeating managed_required.
test("managed enterprise access outranks a leftover self-hosted route", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-routing-test-",
  });

  const { useSettingsStore, selectResolvedLLMConfig } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  // The employee still has a self-hosted cleanup endpoint configured.
  useSettingsStore.setState({
    enterpriseSetupMode: "auto",
    cleanupMode: "self-hosted",
    cleanupRemoteUrl: "http://192.0.2.1:8080",
  });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: managedBedrockConfig(),
    error: null,
  });
  const resolved = () => selectResolvedLLMConfig(useSettingsStore.getState(), "dictationCleanup");

  await t.test("the stale self-hosted mode does not capture the route", () => {
    assert.equal(resolved().mode, "enterprise");
    assert.equal(resolved().provider, "bedrock");
  });

  await t.test("without managed access the self-hosted route still wins", () => {
    useEnterpriseIdentityStore.setState({ config: null, status: "idle" });
    assert.equal(resolved().mode, "self-hosted");
  });
});

test("enterprise call settings cannot omit or bypass a resolved managed route", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-call-settings-test-",
  });
  const { getEnterpriseCallSettings } = await vite.ssrLoadModule(
    "/services/ai/enterpriseSettings.ts"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  useSettingsStore.setState({ enterpriseSetupMode: "auto" });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: managedBedrockConfig(),
    error: null,
    managedScopes: SCOPES,
    enforcedScopes: [],
  });

  const settings = getEnterpriseCallSettings("azure", "dictationCleanup");
  assert.equal(settings.managedContext.provider, "bedrock");
  assert.equal(settings.managedContext.generation, 1);

  useEnterpriseIdentityStore.setState({
    status: "error",
    config: null,
    error: "Company SSO is required",
    managedScopes: SCOPES,
    enforcedScopes: SCOPES,
  });
  assert.throws(
    () => getEnterpriseCallSettings("azure", "dictationCleanup"),
    (error) => error.code === "MANAGED_CONFIG_UNAVAILABLE"
  );
});

test("required managed access applies, and fails closed when its config is gone", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-required-test-",
  });

  const { useSettingsStore, selectResolvedLLMConfig } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  useSettingsStore.setState({
    enterpriseSetupMode: "auto",
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "qwen-local",
  });
  useEnterpriseIdentityStore.setState({ status: "ready", config: managedBedrockConfig() });

  const resolvedMode = () =>
    selectResolvedLLMConfig(useSettingsStore.getState(), "dictationCleanup");

  assert.equal(resolvedMode().provider, "bedrock", "the managed provider applies");

  useEnterpriseIdentityStore.setState({
    status: "error",
    config: null,
    error: "Sign in with company SSO",
    managedScopes: SCOPES,
    enforcedScopes: SCOPES,
  });
  const unavailable = resolvedMode();
  assert.equal(unavailable.mode, "enterprise");
  assert.equal(unavailable.provider, "");
  assert.equal(unavailable.model, "");
});
