/**
 * Stand-in credentials for tests that check a credential is passed through,
 * stripped, or never leaked. They are assembled at runtime so no source line
 * assigns a key-shaped literal, and they are not valid for any provider.
 */
export const FAKE_ANTHROPIC_API_KEY = ["sk", "ant", "fake", "should-not-leak"].join("-");
export const FAKE_ANTHROPIC_AUTH_TOKEN = ["fake", "auth", "token"].join("-");
